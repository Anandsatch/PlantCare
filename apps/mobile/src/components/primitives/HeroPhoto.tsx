// HeroPhoto — the editorial photo block used on A-2 (full-bleed plant detail
// hero), A-3 (camera result), and A-4 (add plant confirmation). One primitive,
// one rounded-corner contract, one cream-skeleton-while-loading behavior.
//
// Why RN's legacy `Image` and not `expo-image`: V1 ships lean. expo-image is a
// real upgrade for caching and progressive loading, but neither is in scope
// for V1 — photos live on local FileSystem (no network round-trip on re-render)
// and we don't need progressive JPEGs. Switch to expo-image when measured
// benefit appears, not before.
//
// Why `accessibilityLabel` is required at the prop type: this is the
// "Photo of Mona the Monstera" announcement that VoiceOver/TalkBack speaks.
// RN's underlying `Image.accessibilityLabel` is optional; we tighten the
// contract one level up so callers can't ship an unlabeled hero photo.
//
// Why a wrapping `View` with `overflow: 'hidden'`: documented Android RN
// gotcha — direct `borderRadius` on `<Image>` does not consistently clip the
// underlying bitmap on Android across resizeMode + image-format combinations.
// A View wrapper with overflow:hidden makes the rounded shape behave
// identically across iOS and Android, with one visual contract.
//
// Why no spinner / no progressive load / no broken-image fallback: the master
// plan favors a quiet cream skeleton during load and a silent cream rectangle
// on error. Loading spinners and broken-image icons read as generic-app polish
// noise; they violate the editorial voice. The accessibilityLabel still
// announces "image, Photo of …" on error so screen readers don't go silent.

import { useState } from 'react';
import { Image, type ImageSourcePropType, View } from 'react-native';

import { useTheme } from '../../hooks/useTheme';

const DEFAULT_RADIUS = 24;

export type HeroPhotoProps = {
  /** RN Image source: `{ uri }` for FileSystem-stored photos, or `require(...)` for static assets. */
  source: ImageSourcePropType;
  /** Image aspect ratio (width / height). Defaults to 1 (square); A-2 overrides for full-bleed. */
  aspectRatio?: number;
  /**
   * Corner radius behavior:
   *   true   → 24 (default; matches DESIGN.md "soft rounded corners")
   *   false  → 0  (sharp corners, used by callers that handle clipping themselves)
   *   number → explicit radius (e.g. smaller radius for A-3/A-4)
   */
  rounded?: boolean | number;
  /**
   * Required announcement for screen readers. Format per master plan:
   * "Photo of {plant.species}" — e.g. "Photo of Monstera Mona". Required at
   * the prop level so callers cannot ship an unlabeled hero photo.
   */
  accessibilityLabel: string;
  testID?: string;
  onLoad?: () => void;
  onError?: () => void;
};

function resolveRadius(rounded: HeroPhotoProps['rounded']): number {
  if (rounded === false) return 0;
  if (typeof rounded === 'number') return rounded;
  // true | undefined → default
  return DEFAULT_RADIUS;
}

export function HeroPhoto({
  source,
  aspectRatio = 1,
  rounded = true,
  accessibilityLabel,
  testID,
  onLoad,
  onError,
}: HeroPhotoProps) {
  const theme = useTheme();
  const [errored, setErrored] = useState(false);

  const radius = resolveRadius(rounded);
  const skeletonColor = theme.colors.surface;

  // Wrapping View carries the radius + overflow:hidden so Android clips the
  // underlying bitmap correctly. The Image fills it; cream backgroundColor on
  // both keeps the skeleton visible during load and behind any transparent
  // image edges on error.
  const containerStyle = {
    width: '100%' as const,
    aspectRatio,
    borderRadius: radius,
    backgroundColor: skeletonColor,
    overflow: 'hidden' as const,
  };

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={containerStyle}
    >
      {!errored && (
        <Image
          source={source}
          // No accessibility props on the Image: the wrapping View owns the
          // a11y identity so screen readers announce once, not twice.
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          resizeMode="cover"
          onLoad={onLoad}
          onError={() => {
            setErrored(true);
            onError?.();
          }}
          style={{ width: '100%', height: '100%', backgroundColor: skeletonColor }}
        />
      )}
    </View>
  );
}
