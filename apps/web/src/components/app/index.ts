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
export { EmptyState } from './EmptyState';
export {
  FileDropzone,
  filesFromDataTransfer,
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
export { ByteSizeInput } from './ByteSizeInput';
export { FormActions, FormRow, OptionRow } from './FormRow';
export { TagEditor, TAG_LIMIT_DEFAULT } from './TagEditor';
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

/* ------------------------------------------------------------------ *
 * Wrapped shadcn primitives
 *
 * One file per primitive under this directory; application code imports the
 * wrapper, never `@/components/ui/*`. Adding a shadcn component means adding its
 * wrapper here first.
 * ------------------------------------------------------------------ */
export { Alert, AlertDescription, AlertTitle } from './Alert';
export { Badge, badgeVariants } from './Badge';
export {
  Button,
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
  buttonVariants,
  type ButtonProps,
} from './Button';
export {
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
  AvatarRoot,
  InitialsAvatar,
} from './Avatar';
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ListRow,
  SectionCard,
} from './Card';
export {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from './Chart';
export { Checkbox } from './Checkbox';
export { Collapsible, CollapsibleContent, CollapsibleTrigger } from './Collapsible';
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
  FormField,
} from './FormField';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  type SelectOption,
} from './Select';
export { Tile } from './Tile';
export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './ContextMenu';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './Dialog';
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './DropdownMenu';
export { Input } from './Input';
export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from './InputGroup';
export { Kbd, KbdGroup } from './Kbd';
export { Label } from './Label';
export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from './Popover';
export { RadioGroup, RadioGroupItem } from './RadioGroup';
export { ScrollArea, ScrollBar } from './ScrollArea';
export { Separator } from './Separator';
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './Sheet';
export { Skeleton } from './Skeleton';
export { Slider } from './Slider';
export { Spinner } from './Spinner';
export { Switch } from './Switch';
export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants } from './Tabs';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './Tooltip';
