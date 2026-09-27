/**
 * The app component kit.
 *
 * Application code imports from here, never from `@/components/ui/*` directly:
 * one wrapper per primitive means one place to change when the design changes.
 * See apps/web/README.md for what each one is for.
 */
export { CodeEditor, type CodeEditorLanguage, type CodeEditorProps } from './CodeEditor';
export { Combobox, type ComboboxOption, type ComboboxProps } from './Combobox';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
export { CopyField } from './CopyField';
export { ChoiceCards, type ChoiceOption } from './ChoiceCards';
export {
  DataTable,
  DEFAULT_PAGE_SIZE,
  selectionColumn,
  type BulkActionContext,
  type DataTableProps,
} from './DataTable';
export {
  DatePicker,
  DateRangePicker,
  type DateRange,
  type DatePickerProps,
  type DateRangePickerProps,
} from './DatePicker';
export { DialogHost } from './DialogHost';
export { EmptyState } from './EmptyState';
export {
  FileDropzone,
  type DroppedFile,
  type FileDropzoneProps,
  type FileRejection,
} from './FileDropzone';
export {
  Bytes,
  BytesPerSecond,
  Dash,
  DateTime,
  Duration,
  Ms,
  Num,
  Pct,
  RelativeTime,
} from './Format';
export { Delta, KpiCard, Sparkline } from './KpiCard';
export {
  Meter,
  MeterStack,
  METER_CRIT_RATIO,
  METER_WARN_RATIO,
  meterToneFor,
  type MeterSegment,
  type MeterSize,
  type MeterTone,
} from './Meter';
export { PageHeader } from './PageHeader';
export { ProviderMark, providerMark, type ProviderMarkSize } from './ProviderMark';
export { SegmentedControl, type SegmentedOption } from './SegmentedControl';
export {
  AccessKeyStatusBadge,
  JobStatusBadge,
  ServerStatusBadge,
  StatusDot,
  UserStatusBadge,
  serverStatusTone,
} from './StatusBadge';
export {
  StepList,
  StepPanels,
  StepperNav,
  useStepper,
  type StepDefinition,
  type StepperApi,
} from './Stepper';
