import { Cell, Pie, PieChart } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/app';
import { useFormat } from '@/lib/format/FormatProvider';

/**
 * The concept's donut, as a real chart rather than a conic gradient: the slices
 * carry a tooltip with the exact size, which is the number an operator came for.
 *
 * The caller decides what the slices are and gives each one a colour token —
 * this draws them and nothing else.
 */
export interface DonutSlice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** A `var(--chart-n)` token, never a literal. */
  readonly color: string;
}

export default function StorageDonut({
  slices,
  ariaLabel,
}: {
  readonly slices: readonly DonutSlice[];
  readonly ariaLabel: string;
}) {
  const format = useFormat();

  const config: ChartConfig = Object.fromEntries(
    slices.map((slice) => [slice.key, { label: slice.label, color: slice.color }]),
  );

  return (
    <ChartContainer config={config} className="aspect-square h-40 w-40 shrink-0">
      <PieChart accessibilityLayer role="img" aria-label={ariaLabel}>
        <ChartTooltip
          content={
            <ChartTooltipContent
              nameKey="label"
              formatter={(value) => format.bytes(Number(value))}
            />
          }
        />
        <Pie
          data={[...slices]}
          dataKey="value"
          nameKey="label"
          innerRadius="62%"
          outerRadius="100%"
          paddingAngle={1.5}
          strokeWidth={0}
        >
          {slices.map((slice) => (
            <Cell key={slice.key} fill={slice.color} />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  );
}
