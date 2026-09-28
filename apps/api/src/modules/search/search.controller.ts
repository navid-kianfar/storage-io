import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { searchQuerySchema, type SearchResponse } from '@storage-io/contracts';
import { dtoFrom } from '../../common/dto';
import { SearchService } from './search.service';

class SearchQueryDto extends dtoFrom(searchQuerySchema) {}

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Servers, buckets, users, keys, policies and jobs matching `q`' })
  find(@Query() query: SearchQueryDto): Promise<SearchResponse> {
    return this.search.search(query);
  }
}
