/**
 * The shadcn Recharts wrapper. Recharts is a large dependency and deliberately
 * outside the initial bundle — a page that charts loads its chart section with
 * `lazy()` so importing this file never widens the first paint.
 */
export {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
