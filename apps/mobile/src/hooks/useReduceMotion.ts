import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Returns true when the OS-level "Reduce Motion" accessibility preference is
 * enabled. Drives the A-3 diagnose loading 3-bucket pulsing copy (0-8s / 8-20s /
 * 20s+) into a static line, and gates any future transitions/animations.
 *
 * Defaults to `false` during the brief async window before
 * `AccessibilityInfo.isReduceMotionEnabled()` resolves — matches the iOS factory
 * default and the harmless biased-toward-motion fallback documented in the plan.
 */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => {
        // Fall through to the false default — biased toward motion is the
        // harmless choice if the platform fails to report a preference.
      });

    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled: boolean) => {
        if (mounted) setReduceMotion(enabled);
      },
    );

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}
