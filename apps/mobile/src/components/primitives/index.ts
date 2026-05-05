// Barrel for the icon primitives shipped in E2-006. Future primitives
// (StatusChip in E2-007, EditorialButton in E2-008, FAB in E2-009) live in
// their own files in this directory and are re-exported here.
// Barrel for the primitives. Icon primitives shipped in E2-006; <StatusChip>
// in E2-007. Future primitives (EditorialButton in E2-008, FAB in E2-009)
// live in their own files in this directory and are re-exported here.
export { Droplet } from './Droplet';
export type { DropletProps } from './Droplet';
export { LeafIcon } from './LeafIcon';
export type { LeafIconProps } from './LeafIcon';
export { HandOnSoilIcon } from './HandOnSoilIcon';
export type { HandOnSoilIconProps } from './HandOnSoilIcon';
<<<<<<< HEAD
// Primitive components barrel. Each new primitive (Droplet, LeafIcon, FAB,
// HeroPhoto, etc.) lands here in its own ticket — do not pre-export shells.
export { EditorialButton, type EditorialButtonProps } from './EditorialButton';
// Primitives barrel. Future E2 tickets append here.
export { FAB, type FABProps } from './FAB';
// Primitives barrel. Per-screen composites import from here so call sites stay
// flat (`import { HeroPhoto } from '@/components/primitives'`).
export { HeroPhoto, type HeroPhotoProps } from './HeroPhoto';
// Conservatory primitives barrel. Each primitive is its own ticket in Epic E2;
// this barrel exists so screens can `import { ... } from '@/components/primitives'`
// regardless of which primitives have shipped on a given branch.
export {
  EditorialBottomSheet,
  shouldDismissOnDragRelease,
  type EditorialBottomSheetProps,
} from './EditorialBottomSheet';
// Primitives barrel — Conservatory design system building blocks.
// Re-exports types alongside components so screens consuming a primitive
// can also import its prop types from a single path.
export { ToastBanner } from './ToastBanner';
export type { ToastBannerAction, ToastBannerProps, ToastBannerType } from './ToastBanner';
=======
export { StatusChip } from './StatusChip';
export type { StatusChipProps } from './StatusChip';
>>>>>>> 2ceb302 (v0.1.21.0 feat(E2-007): StatusChip primitive (water/skip/soil))
