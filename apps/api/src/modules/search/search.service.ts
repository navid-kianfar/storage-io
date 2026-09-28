import { Injectable, Logger } from '@nestjs/common';
import {
  PROVIDER_LABELS,
  type Provider,
  type SearchQuery,
  type SearchResponse,
  type SearchResult,
} from '@storage-io/contracts';
import { ServerRepository } from '../../servers/server.repository';
import { InventoryRepository } from '../inventory/inventory.repository';
import { JobsRepository } from '../jobs/jobs.repository';
import { IamUsersService } from '../iam-users/iam-users.service';
import { IamGroupsService } from '../iam-groups/iam-groups.service';
import { AccessKeysService } from '../access-keys/access-keys.service';
import { IamPoliciesService } from '../iam-policies/iam-policies.service';

/**
 * `GET /search` — what the command palette calls on every keystroke.
 *
 * ## Two speeds, one budget
 *
 * Servers, buckets and jobs are local tables: three indexed queries, microseconds.
 * Users, keys and policies are **live** — the IAM drivers have no local mirror of
 * them — so they fan out to every capable server, and one slow server would
 * otherwise make the palette feel broken.
 *
 * So the IAM half runs against a deadline. Whatever answers inside
 * `IAM_BUDGET_MS` is included; whatever does not is simply absent from this
 * keystroke's results, and the next keystroke tries again. A palette that shows
 * fewer results quickly is usable; one that shows all of them in four seconds is
 * not, and the operator will have typed three more characters by then anyway.
 *
 * A failing IAM call is swallowed for the same reason: an unreachable server must
 * not turn a search into a 502.
 *
 * ## Ordering
 *
 * Results come back grouped by type in a fixed order — servers, buckets, users,
 * groups, keys, policies, jobs — rather than interleaved by relevance. A palette is read
 * by shape: an operator looking for a bucket scans the bucket block, and a
 * relevance score that moved a bucket above a server on one keystroke and below it
 * on the next would make that impossible.
 *
 * ## Ids, never names
 *
 * `id` is the entity's own opaque id and `href` is a route from docs/ROUTES.md
 * built from that id alone. A name in a URL is wrong twice over: it is unique only
 * within one server, and it may contain characters no path segment survives.
 */

/** What the live half of the search is allowed to take. */
export const IAM_BUDGET_MS = 1_500;
/** Per type, before the overall limit is applied. */
const PER_TYPE_LIMIT = 10;

@Injectable()
export class SearchService {
  private readonly log = new Logger(SearchService.name);

  constructor(
    private readonly servers: ServerRepository,
    private readonly inventory: InventoryRepository,
    private readonly jobs: JobsRepository,
    private readonly users: IamUsersService,
    private readonly groups: IamGroupsService,
    private readonly keys: AccessKeysService,
    private readonly policies: IamPoliciesService,
  ) {}

  async search(query: SearchQuery): Promise<SearchResponse> {
    const needle = query.q.trim();
    if (needle.length === 0) return { items: [] };

    const local = [...this.matchServers(needle), ...this.matchBuckets(needle)];
    const live = await this.matchIam(needle);
    const jobs = this.matchJobs(needle);

    return { items: [...local, ...live, ...jobs].slice(0, query.limit) };
  }

  /* ------------------------------- local ---------------------------- */

  private matchServers(needle: string): readonly SearchResult[] {
    return this.servers
      .findAll({ q: needle })
      .slice(0, PER_TYPE_LIMIT)
      .map((row) => ({
        type: 'server' as const,
        id: row.id,
        label: row.name,
        sublabel: `${PROVIDER_LABELS[row.provider as Provider]} · ${row.status}`,
        href: `/servers/${row.id}`,
        // A server's status is not a job status; the sublabel carries it.
        status: null,
      }));
  }

  private matchBuckets(needle: string): readonly SearchResult[] {
    const buckets = this.inventory.list(
      { q: needle, sort: 'name' },
      { page: 1, pageSize: PER_TYPE_LIMIT },
    );
    return buckets.map((bucket) => ({
      type: 'bucket' as const,
      id: bucket.id,
      label: bucket.name,
      sublabel: `Bucket on ${bucket.serverName}`,
      href: `/buckets/${bucket.id}`,
      status: null,
    }));
  }

  private matchJobs(needle: string): readonly SearchResult[] {
    return this.jobs.search(needle, PER_TYPE_LIMIT).map((row) => {
      const job = this.jobs.toContract(row);
      return {
        type: 'job' as const,
        id: job.id,
        label: job.name,
        sublabel: `${job.type} · ${job.status}`,
        href: `/jobs/${job.id}`,
        // The one type that carries a status, so the palette can badge a
        // running job without a second request.
        status: job.status,
      };
    });
  }

  /* -------------------------------- live ---------------------------- */

  /**
   * The four IAM searches, raced against one shared deadline. `Promise.all` over
   * already-deadlined promises rather than `Promise.race`: each one has to either
   * produce its own results or give up on its own, and a race would discard three
   * answers because a fourth was slow.
   */
  private async matchIam(needle: string): Promise<readonly SearchResult[]> {
    const deadline = Date.now() + IAM_BUDGET_MS;

    const [users, groups, keys, policies] = await Promise.all([
      this.withBudget(deadline, 'users', async () => {
        const page = await this.users.list({ q: needle, page: 1, pageSize: PER_TYPE_LIMIT });
        return page.items.map((user): SearchResult => ({
          type: 'user',
          id: user.id,
          label: user.name,
          sublabel: `S3 user on ${user.serverName}`,
          href: `/users/${user.id}`,
          status: null,
        }));
      }),
      this.withBudget(deadline, 'groups', async () => {
        // `listIamGroupsQuerySchema` has no paging, like the policy list.
        const page = await this.groups.list({ q: needle });
        return page.items.slice(0, PER_TYPE_LIMIT).map((group): SearchResult => ({
          type: 'group',
          id: group.id,
          label: group.name,
          sublabel: `Group on ${group.serverName}`,
          href: `/users/groups/${group.id}`,
          status: null,
        }));
      }),
      this.withBudget(deadline, 'keys', async () => {
        const page = await this.keys.list({ q: needle, page: 1, pageSize: PER_TYPE_LIMIT });
        return page.items.map((key): SearchResult => ({
          type: 'key',
          id: key.id,
          label: key.name ?? key.accessKeyId,
          sublabel: `Access key for ${key.userName} on ${key.serverName}`,
          // There is no key detail route; editing it is what the palette opens.
          href: `/keys/${key.id}/edit`,
          status: null,
        }));
      }),
      this.withBudget(deadline, 'policies', async () => {
        // `listIamPoliciesQuerySchema` has no paging — the driver returns the whole
        // set — so the slice below is what bounds it.
        const page = await this.policies.list({ q: needle });
        return page.items.slice(0, PER_TYPE_LIMIT).map((policy): SearchResult => ({
          type: 'policy',
          id: policy.id,
          label: policy.name,
          sublabel: `Policy on ${policy.serverName}`,
          href: `/policies/${policy.id}`,
          status: null,
        }));
      }),
    ]);

    return [...users, ...groups, ...keys, ...policies];
  }

  /**
   * Runs one live search with a shared deadline. An overrun or a failure yields an
   * empty block, which the palette shows as "no users matched" — wrong only until
   * the next keystroke, and far better than a spinner or a 502.
   */
  private async withBudget(
    deadline: number,
    what: string,
    run: () => Promise<readonly SearchResult[]>,
  ): Promise<readonly SearchResult[]> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return [];

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<readonly SearchResult[]>((resolve) => {
      timer = setTimeout(() => {
        this.log.debug({ what, budgetMs: IAM_BUDGET_MS }, 'Search gave up on a live source');
        resolve([]);
      }, remaining);
    });

    try {
      return await Promise.race([run(), timeout]);
    } catch (error) {
      this.log.debug(
        { what, err: error instanceof Error ? error.message : String(error) },
        'A live search source failed',
      );
      return [];
    } finally {
      // The losing promise keeps running to completion; only its timer is cleared,
      // so nothing holds the event loop open after the answer has been sent.
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
