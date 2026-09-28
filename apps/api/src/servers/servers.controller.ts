import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createServerRequestSchema,
  listServersQuerySchema,
  serverEventsQuerySchema,
  serverMetricsQuerySchema,
  setMaintenanceRequestSchema,
  updateServerRequestSchema,
  type Server,
  type ServerDriveList,
  type ServerHealthEventList,
  type ServerList,
  type ServerMetrics,
  type ServerNodeList,
  type TestServerResponse,
} from '@storage-io/contracts';
import { dtoFrom } from '../common/dto';
import { LogActivity } from '../activity/activity.interceptor';
import { HealthCheckerService } from './health-checker.service';
import { ServersService } from './servers.service';

class ListServersQueryDto extends dtoFrom(listServersQuerySchema) {}
class CreateServerDto extends dtoFrom(createServerRequestSchema) {}
class UpdateServerDto extends dtoFrom(updateServerRequestSchema) {}
class SetMaintenanceDto extends dtoFrom(setMaintenanceRequestSchema) {}
class ServerMetricsQueryDto extends dtoFrom(serverMetricsQuerySchema) {}
class ServerEventsQueryDto extends dtoFrom(serverEventsQuerySchema) {}

/**
 * Thin by design: validate, delegate, map. Every decision lives in
 * `ServersService` or the health checker.
 *
 * Route order matters — `/servers/test` and `/servers/check-all` are declared
 * before `/servers/:id`, or Express would match `test` as an id.
 */
@ApiTags('servers')
@Controller('servers')
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly health: HealthCheckerService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List storage servers' })
  list(@Query() query: ListServersQueryDto): ServerList {
    return this.servers.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @LogActivity({ category: 'servers', action: 'server.create', title: 'Added a storage server' })
  @ApiOperation({ summary: 'Add a storage server' })
  async create(@Body() body: CreateServerDto): Promise<Server> {
    return this.servers.create(body);
  }

  @Post('test')
  @LogActivity({ category: 'servers', action: 'server.test', title: 'Tested a connection' })
  @ApiOperation({ summary: 'Test an unsaved connection' })
  async testUnsaved(@Body() body: CreateServerDto): Promise<TestServerResponse> {
    return this.servers.testUnsaved(body);
  }

  @Post('check-all')
  @HttpCode(HttpStatus.ACCEPTED)
  @LogActivity({ category: 'servers', action: 'server.check-all', title: 'Checked every server' })
  @ApiOperation({ summary: 'Run a health check on every server' })
  checkAll(): void {
    // Accepted, not awaited: with a dozen servers this takes longer than a
    // request should, and the results arrive over SSE.
    void this.health.checkAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'One server, by id or name' })
  findOne(@Param('id') id: string): Server {
    return this.servers.findOne(id);
  }

  @Patch(':id')
  @LogActivity({ category: 'servers', action: 'server.update', title: 'Edited a storage server' })
  @ApiOperation({ summary: 'Edit a connection; omit the secret to keep it' })
  async update(@Param('id') id: string, @Body() body: UpdateServerDto): Promise<Server> {
    return this.servers.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({ category: 'servers', action: 'server.delete', title: 'Removed a storage server' })
  @ApiOperation({ summary: 'Forget a connection; data on the server is untouched' })
  remove(@Param('id') id: string): void {
    this.servers.delete(id);
  }

  @Post(':id/test')
  @LogActivity({ category: 'servers', action: 'server.test', title: 'Tested a connection' })
  @ApiOperation({ summary: 'Test a saved connection and store the result' })
  async testSaved(@Param('id') id: string): Promise<TestServerResponse> {
    return this.servers.testSaved(id);
  }

  @Post(':id/check')
  @LogActivity({ category: 'servers', action: 'server.check', title: 'Ran a health check' })
  @ApiOperation({ summary: 'Run a health check now and return the server' })
  async check(@Param('id') id: string): Promise<Server> {
    const server = this.servers.findOne(id);
    await this.health.checkNow(server.id);
    return this.servers.findOne(id);
  }

  @Put(':id/maintenance')
  @LogActivity({
    category: 'servers',
    action: 'server.maintenance',
    title: 'Changed maintenance mode',
  })
  @ApiOperation({ summary: 'Turn maintenance mode on or off' })
  setMaintenance(@Param('id') id: string, @Body() body: SetMaintenanceDto): Server {
    return this.servers.setMaintenance(id, body.enabled);
  }

  @Get(':id/metrics')
  @ApiOperation({ summary: 'Capacity and latency series, plus uptime' })
  metrics(@Param('id') id: string, @Query() query: ServerMetricsQueryDto): ServerMetrics {
    return this.servers.metrics(id, query.range);
  }

  @Get(':id/nodes')
  @ApiOperation({ summary: 'Nodes and drive counts (NOT_SUPPORTED without the capability)' })
  async nodes(@Param('id') id: string): Promise<ServerNodeList> {
    return { items: [...(await this.servers.nodes(id))] };
  }

  @Get(':id/nodes/:node/drives')
  @ApiOperation({ summary: 'Drives on one node' })
  async drives(@Param('id') id: string, @Param('node') node: string): Promise<ServerDriveList> {
    return { items: [...(await this.servers.drives(id, node))] };
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'Recent health events' })
  events(@Param('id') id: string, @Query() query: ServerEventsQueryDto): ServerHealthEventList {
    return { items: [...this.servers.events(id, query.limit)] };
  }
}
