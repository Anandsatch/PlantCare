// Barrel for the icon primitives shipped in E2-006. Future primitives
// (StatusChip in E2-007, EditorialButton in E2-008, FAB in E2-009) live in
// their own files in this directory and are re-exported here.
export { Droplet } from './Droplet';
export type { DropletProps } from './Droplet';
export { LeafIcon } from './LeafIcon';
export type { LeafIconProps } from './LeafIcon';
export { HandOnSoilIcon } from './HandOnSoilIcon';
export type { HandOnSoilIconProps } from './HandOnSoilIcon';
// Primitive components barrel. Each new primitive (Droplet, LeafIcon, FAB,
// HeroPhoto, etc.) lands here in its own ticket — do not pre-export shells.
export { EditorialButton, type EditorialButtonProps } from './EditorialButton';
