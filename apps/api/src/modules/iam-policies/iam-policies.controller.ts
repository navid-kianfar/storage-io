import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  listIamPoliciesQuerySchema,
  putPolicyRequestSchema,
  simulatePolicyRequestSchema,
  validatePolicyRequestSchema,
  type PolicyDetail,
  type PolicyList,
  type PolicyVersionList,
  type SimulatePolicyResponse,
  type ValidatePolicyResponse,
} from '@storage-io/contracts';
import { dtoFrom } from '../../common/dto';
import { LogActivity, SkipActivity } from '../../activity/activity.interceptor';
import { IamPoliciesService } from './iam-policies.service';

class ListIamPoliciesQueryDto extends dtoFrom(listIamPoliciesQuerySchema) {}
class PutPolicyDto extends dtoFrom(putPolicyRequestSchema) {}
class ValidatePolicyDto extends dtoFrom(validatePolicyRequestSchema) {}
class SimulatePolicyDto extends dtoFrom(simulatePolicyRequestSchema) {}

/**
 * `validate` and `simulate` are POSTs that change nothing — the policy editor calls
 * them on every keystroke — so they carry `@SkipActivity()`. Without it the audit
 * log would be a transcript of someone typing.
 */
@ApiTags('iam-policies')
@Controller()
export class IamPoliciesController {
  constructor(private readonly policies: IamPoliciesService) {}

  @Get('iam/policies')
  @ApiOperation({ summary: 'Policies across every server that has them' })
  async list(@Query() query: ListIamPoliciesQueryDto): Promise<PolicyList> {
    return this.policies.list(query);
  }

  @Post('iam/policies/validate')
  @SkipActivity()
  @ApiOperation({ summary: 'Structural validation of a policy document' })
  validate(@Body() body: ValidatePolicyDto): ValidatePolicyResponse {
    return this.policies.validate(body);
  }

  @Post('iam/policies/simulate')
  @SkipActivity()
  @ApiOperation({ summary: 'Evaluate one action and resource against a document' })
  simulate(@Body() body: SimulatePolicyDto): SimulatePolicyResponse {
    return this.policies.simulate(body);
  }

  @Get('servers/:sid/iam/policies/:name/versions')
  @ApiOperation({ summary: "storage-io's snapshots of this policy, newest first" })
  listVersions(@Param('sid') sid: string, @Param('name') name: string): PolicyVersionList {
    return this.policies.listVersions(sid, name);
  }

  @Post('servers/:sid/iam/policies/:name/versions/:vid/restore')
  @LogActivity({
    category: 'access',
    action: 'iam-policy.restore',
    title: 'Restored a policy version',
    failureTitle: 'Failed to restore a policy version',
  })
  @ApiOperation({ summary: 'Write a stored version back to the server' })
  async restore(
    @Param('sid') sid: string,
    @Param('name') name: string,
    @Param('vid') vid: string,
  ): Promise<PolicyDetail> {
    return this.policies.restoreVersion(sid, name, vid);
  }

  @Get('servers/:sid/iam/policies/:name')
  @ApiOperation({ summary: 'One policy, with its document and what it is attached to' })
  async findOne(@Param('sid') sid: string, @Param('name') name: string): Promise<PolicyDetail> {
    return this.policies.findOne(sid, name);
  }

  @Put('servers/:sid/iam/policies/:name')
  @LogActivity({
    category: 'access',
    action: 'iam-policy.put',
    title: 'Saved a policy',
    failureTitle: 'Failed to save a policy',
  })
  @ApiOperation({ summary: 'Create or replace a policy (built-ins are read-only)' })
  async put(
    @Param('sid') sid: string,
    @Param('name') name: string,
    @Body() body: PutPolicyDto,
  ): Promise<PolicyDetail> {
    return this.policies.put(sid, name, body);
  }

  @Delete('servers/:sid/iam/policies/:name')
  @HttpCode(HttpStatus.NO_CONTENT)
  @LogActivity({
    category: 'access',
    action: 'iam-policy.delete',
    title: 'Deleted a policy',
    failureTitle: 'Failed to delete a policy',
  })
  @ApiOperation({ summary: 'Delete a policy that nothing is attached to' })
  async remove(@Param('sid') sid: string, @Param('name') name: string): Promise<void> {
    await this.policies.delete(sid, name);
  }
}
