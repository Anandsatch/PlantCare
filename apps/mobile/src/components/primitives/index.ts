// Conservatory primitives barrel. Each primitive ships in its own E2 ticket;
// screens import from here so call sites stay flat
// (`import { ... } from '@/components/primitives'`).

export { Droplet } from './Droplet';
export type { DropletProps } from './Droplet';
export { LeafIcon } from './LeafIcon';
export type { LeafIconProps } from './LeafIcon';
export { HandOnSoilIcon } from './HandOnSoilIcon';
export type { HandOnSoilIconProps } from './HandOnSoilIcon';
export { StatusChip } from './StatusChip';
export type { StatusChipProps } from './StatusChip';
export { EditorialButton, type EditorialButtonProps } from './EditorialButton';
export { FAB, type FABProps } from './FAB';
export { FABPopover, fabPopoverStyles, type FABPopoverProps } from './FABPopover';
export { HeroPhoto, type HeroPhotoProps } from './HeroPhoto';
export {
  EditorialBottomSheet,
  shouldDismissOnDragRelease,
  type EditorialBottomSheetProps,
} from './EditorialBottomSheet';
export { ToastBanner } from './ToastBanner';
export type { ToastBannerAction, ToastBannerProps, ToastBannerType } from './ToastBanner';
