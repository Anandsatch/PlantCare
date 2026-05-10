/**
 * <AddPlantScreen> — A-4 (post-identify add plant flow).
 *
 * Inputs:  `{ photoUri }` from the FAB → camera flow (E5-011 wires that).
 * Outputs: `onSave({ species, nickname?, photoUri })` callback to the
 *          parent screen / navigator. DB write lives elsewhere (E5-011 or
 *          the eventual Add-plant integration ticket); this screen does
 *          NOT touch SQLite.
 *
 * Flow (the discriminated union must NOT collapse — codex P1 risk surface):
 *
 *      ┌────────────────────┐  mount
 *      │ phase: 'compress'  │ ── compressPhoto(photoUri) ──┐
 *      └────────────────────┘                              │
 *                                                          v
 *                                       ┌────────────────────────────┐
 *                                       │ phase: 'identifying'       │
 *                                       │ <DiagnoseLoadingState>     │
 *                                       └─────────┬──────────────────┘
 *                                                 │ identifyResult
 *                                                 │
 *                ┌────────────────────────────────┼──────────────────────────────────┐
 *                │ ok + has candidates            │ ok + 0% match                    │ error / queued
 *                v                                v                                  v
 *      ┌────────────────────┐         ┌────────────────────┐                ┌────────────────────┐
 *      │ view: 'candidates' │ ◄────── │ view: 'picker'     │ ─── pick ────► │ view: 'picker'     │
 *      │  - top-3 cards     │  pick   │  - searchable list │                │  - same picker     │
 *      │  - "Save as <X>"   │  from   │  - "Save as <X>"   │                │  - banner: error   │
 *      │  - "Pick from list"│  list   └────────────────────┘                └────────────────────┘
 *      └────────────────────┘
 *
 * "Pick from list" is a manual override on the candidates view; "Tap to
 * override" in the A-4 mockup. The view variable is independent of the
 * identify result kind so the override path doesn't need to fake-out the
 * phase machine.
 *
 * Reduce-motion: the only animation in this screen is the loading-state
 * pulse, which `useReduceMotion` (E2-004) gates inside DiagnoseLoadingState.
 * No additional transforms / fade-ins on the screen itself. Compliance is
 * therefore audit-defensible by composition.
 *
 * AppState resume: useIdentifyRequest's call-counter + mountedRef guard
 * ensures that an identify request started before backgrounding does NOT
 * double-fire on `'active'` resume. We additionally guard the *first*
 * identify dispatch with a `dispatchedRef` so that even if React strict-mode
 * remounts or AppState churn causes the effect to re-run, identify fires
 * exactly once per mount of the screen. Codex P1 risk surface (b).
 *
 * Nickname text is preserved verbatim — emoji, unicode, leading/trailing
 * whitespace are all forwarded to onSave as the user typed them. We do not
 * sanitize. Codex P2 risk surface (f).
 *
 * Submit is disabled until a species has been picked AND a non-empty
 * `photoUri` exists AND the screen isn't actively saving. The button stays
 * disabled while `onSave` is in flight to prevent double-submit.
 */

import { fonts } from '@plantcare/theme';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import * as RN from 'react-native';
import {
  AccessibilityInfo,
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';

import type { ApiClient, ApiResult, IdentifyResponse } from '../api';
import { DiagnoseLoadingState } from '../components/DiagnoseLoadingState';
import { HeroPhoto } from '../components/primitives';
import { EditorialButton } from '../components/primitives/EditorialButton';
import { useIdentifyRequest, type NetInfoLike } from '../hooks/useIdentifyRequest';
import { useTheme } from '../hooks/useTheme';
import { compressPhoto, type CompressPhotoResult } from '../photos';
import {
  filterSpecies,
  SPECIES_CATALOG,
  type SpeciesEntry,
} from './speciesCatalog';

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Candidate species, ranked by confidence. Built from the IdentifyResponse:
 *   primary  → { species_slug, species_label, confidence }
 *   alts[0..2] → from response.alternatives, capped at top-3 total.
 */
export type AddPlantCandidate = {
  readonly slug: string;
  readonly label: string;
  /** 0-100 from /api/identify (or the picker, where it's just 100). */
  readonly confidence: number;
};

/**
 * Internal screen-result kind. Layered on top of `ApiResult<IdentifyResponse>`
 * so the screen can fork on 'no_match' as a distinct UI path even though
 * the wire envelope returns ok=true with confidence=0 / species_slug='unknown'.
 *
 * The discriminated union must NOT be collapsed (codex P1 risk surface a).
 * Each arm renders a different surface: 'ok' shows candidate cards;
 * 'no_match' jumps straight to the manual picker; 'queued' shows the tan
 * banner and the picker (so the user can still proceed offline); 'error'
 * shows the picker with an error banner above it.
 */
export type AddPlantIdentifyResult =
  | { readonly kind: 'ok'; readonly candidates: ReadonlyArray<AddPlantCandidate> }
  | { readonly kind: 'no_match' }
  | { readonly kind: 'queued' }
  | { readonly kind: 'error'; readonly errorKind: string; readonly message?: string };

/**
 * Save payload — shape-aligned with `CreatePlantInput` from `db/types.ts`
 * so the parent's DB-write path (E5-011 / future ticket) can pass these
 * fields straight through with at most a `hero_photo_id` resolution step
 * (insert a `photos` row from `photoUri`, take its id, then call
 * `usePlants().create({ ...payload, hero_photo_id })`).
 *
 * Codex P2 (d) — payload shape vs DB row shape — addressed by emitting the
 * wire-stable column names (`species_slug`, `species_label`,
 * `identify_confidence`) here. Keeping `photoUri` (camelCase) separate from
 * the column names because the column it eventually populates
 * (`hero_photo_id`) is a foreign key, not the URI itself.
 */
export type AddPlantSavePayload = {
  /** snake_case species id matching backend /api/identify keyspace + plants.species_slug. */
  readonly species_slug: string;
  /** Title-Case label. Maps to plants.species_label. */
  readonly species_label: string;
  /**
   * Optional 0..100 confidence from /api/identify when the user accepted a
   * candidate. Omitted (undefined) when the user picked from the manual
   * list — the picker doesn't know a confidence; the DB column is nullable.
   */
  readonly identify_confidence?: number;
  /** Verbatim user input — emoji + unicode preserved. Empty key omitted. */
  readonly nickname?: string;
  /** On-device URI of the (compressed) hero photo. Parent inserts the photo row. */
  readonly photoUri: string;
};

export type AddPlantScreenProps = {
  /** On-device URI of the captured photo. May be uncompressed; the screen compresses before identify. */
  readonly photoUri: string;
  /** API client used to call /api/identify. Same singleton-or-injected pattern as the camera flow. */
  readonly apiClient: ApiClient;
  /** Connectivity probe forwarded to useIdentifyRequest. Defaults to "always online". */
  readonly netInfo?: NetInfoLike;
  /** Callback invoked when the user taps "Save as <species>". DB write lives in the parent. */
  readonly onSave: (payload: AddPlantSavePayload) => void | Promise<void>;
  /** Cancel / back affordance from the parent navigator. */
  readonly onCancel?: () => void;
  /**
   * Test seam: bypass the photo-compression step. When provided, the screen
   * skips compressPhoto and uses this URI directly. Production code paths
   * never set this.
   */
  readonly skipCompress?: boolean;
  /**
   * E11-006 insertion path. Forwarded to `useIdentifyRequest` so a
   * terminal-success identify call advances the SQLite budget meter
   * `useLlmBudget()` reads. Optional — when omitted, the hook is a
   * no-op on the budget side. Production wires this from the route
   * layer with a `() => openDb()` factory; tests can pass a stub
   * writer or omit entirely.
   */
  readonly budgetDb?: import('../lib/llmBudget').LlmCallWriter
    | (() => Promise<import('../lib/llmBudget').LlmCallWriter>);
  readonly testID?: string;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Convert the wire-shaped ApiResult<IdentifyResponse> into the screen's
 * internal discriminated union. Locked rules:
 *
 *   ok + species_slug !== 'unknown' + confidence > 0  → 'ok' with candidates.
 *   ok + species_slug === 'unknown'                   → 'no_match'.
 *   ok + confidence === 0                             → 'no_match'.
 *   !ok + kind === 'queued'                           → 'queued'.
 *   !ok                                               → 'error'.
 *
 * The candidate list is the primary species + alternatives, capped at 3 and
 * sorted descending by confidence (the backend already sorts, but a defensive
 * re-sort is cheap and survives wire-shape drift).
 */
export function toAddPlantResult(
  api: ApiResult<IdentifyResponse>,
): AddPlantIdentifyResult {
  if (!api.ok) {
    if (api.kind === 'queued') return { kind: 'queued' };
    return { kind: 'error', errorKind: api.kind, message: api.message };
  }
  const data = api.data;
  if (data.species_slug === 'unknown' || data.confidence === 0) {
    return { kind: 'no_match' };
  }
  const primary: AddPlantCandidate = {
    slug: data.species_slug,
    label: data.species_label,
    confidence: data.confidence,
  };
  const alts: AddPlantCandidate[] = (data.alternatives ?? [])
    .filter((a) => a.species_slug && a.species_slug !== 'unknown')
    .map((a) => ({
      slug: a.species_slug,
      label: a.species_label,
      confidence: a.confidence,
    }));
  const candidates = [primary, ...alts]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
  return { kind: 'ok', candidates };
}

// ─── Component ─────────────────────────────────────────────────────────────

type Phase = 'compressing' | 'identifying' | 'ready';
type ViewMode = 'candidates' | 'picker';

export function AddPlantScreen({
  photoUri,
  apiClient,
  netInfo,
  onSave,
  onCancel,
  skipCompress,
  budgetDb,
  testID,
}: AddPlantScreenProps): ReactElement {
  const theme = useTheme();
  const { identify, status: identifyStatus } = useIdentifyRequest({
    apiClient,
    netInfo,
    ...(budgetDb ? { budgetDb } : {}),
  });

  const [phase, setPhase] = useState<Phase>(skipCompress ? 'identifying' : 'compressing');
  const [view, setView] = useState<ViewMode>('candidates');
  const [compressed, setCompressed] = useState<CompressPhotoResult | null>(null);
  const [identifyResult, setIdentifyResult] = useState<AddPlantIdentifyResult | null>(
    null,
  );
  // The full selection includes a confidence so we can pass it through to
  // the parent's DB-write path. Confidence is only present when the user
  // accepted an identify candidate; the manual picker leaves it undefined.
  const [selected, setSelected] = useState<{
    slug: string;
    label: string;
    confidence?: number;
  } | null>(null);
  // Free-text nickname. Preserved verbatim including emoji + unicode (codex
  // P2 risk surface f). Default empty; submit works either with empty or set.
  const [nickname, setNickname] = useState<string>('');
  const [filterText, setFilterText] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  // Fire identify exactly once per mount. Even if AppState fires 'active' on
  // foreground (which doesn't here, but the dispatchedRef defends against
  // any future churn — codex P1 risk surface b: AppState resume must not
  // double-fire identify).
  const dispatchedRef = useRef(false);

  // Refs on the active section header so we can hand off screen-reader
  // focus when the view swaps from loading → candidates / picker. Codex P2
  // (e) — announcement via accessibilityLiveRegion is not enough; without
  // setAccessibilityFocus, focus can remain stranded on the unmounted
  // loading subtree. We capture the reactTag and call
  // `AccessibilityInfo.setAccessibilityFocus` on the next paint after the
  // header mounts.
  const candidatesHeaderRef = useRef<Text | null>(null);
  const pickerHeaderRef = useRef<Text | null>(null);

  // ── Compress + identify pipeline ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      if (dispatchedRef.current) return;
      dispatchedRef.current = true;

      // 1. Compress (skippable for tests).
      let workingUri = photoUri;
      if (!skipCompress) {
        try {
          const result = await compressPhoto({ sourceUri: photoUri });
          if (cancelled) return;
          setCompressed(result);
          workingUri = result.uri;
        } catch (err) {
          // Compression failure is rare (FileSystem unavailable, source
          // missing). Surface as 'error' result and jump straight to the
          // manual picker so the user isn't stuck.
          if (cancelled) return;
          setIdentifyResult({
            kind: 'error',
            errorKind: 'compress_failed',
            message: (err as Error)?.message,
          });
          setPhase('ready');
          setView('picker');
          return;
        }
      }

      // 2. Identify.
      if (cancelled) return;
      setPhase('identifying');
      const apiResult = await identify({ photoUri: workingUri });
      if (cancelled) return;
      const result = toAddPlantResult(apiResult);
      setIdentifyResult(result);
      setPhase('ready');
      // 0% match / error / queued → start in picker view. 'ok' stays in candidates.
      if (result.kind !== 'ok') {
        setView('picker');
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
    // identify is stable across renders (useCallback in useIdentifyRequest);
    // photoUri changes are not expected during a screen's lifetime — the
    // screen unmounts and remounts with a new photo. Including it here keeps
    // the lint quiet without changing behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoUri, skipCompress]);

  // ── A11y focus handoff on view swap ───────────────────────────────────────
  // When phase flips to 'ready' the loading subtree unmounts and the
  // candidates / picker mounts. Move screen-reader focus to the new header
  // so VoiceOver/TalkBack users hear the new context instead of being
  // stranded on the unmounted loading view. Falls through silently when
  // either the ref or the platform's AccessibilityInfo doesn't resolve a
  // node handle (e.g. test renderers without native bridge).
  useEffect(() => {
    if (phase !== 'ready') return;
    const target =
      view === 'candidates' && identifyResult?.kind === 'ok'
        ? candidatesHeaderRef.current
        : pickerHeaderRef.current;
    if (!target) return;
    const handle = RN.findNodeHandle(target);
    if (handle == null) return;
    // Defer to the next paint so the new subtree is mounted on screen
    // readers' side before focus moves. requestAnimationFrame is the right
    // schedule on RN; setTimeout(0) would race the commit on slower devices.
    const raf = requestAnimationFrame(() => {
      AccessibilityInfo.setAccessibilityFocus(handle);
    });
    return () => cancelAnimationFrame(raf);
  }, [phase, view, identifyResult]);

  // ── AppState resume: defensive — re-render-only, no double-fire ───────────
  // Even though dispatchedRef guards the dispatch, a background → active
  // transition occasionally re-runs effects on certain RN/Expo versions. We
  // listen so we can no-op explicitly (rather than rely on absent listener).
  // The subscription return shape is `{ remove }` on RN >= 0.65; older
  // shimmed test stubs occasionally return `undefined` from the listener add
  // (jest-expo's default node mock did this in some past versions). Guard
  // against the undefined case so the cleanup path never throws.
  useEffect(() => {
    const sub = AppState.addEventListener('change', () => {
      // Intentional no-op. dispatchedRef + identify's call-counter both
      // protect against duplicate fires; this listener exists so that the
      // "AppState resume doesn't double-fire" contract is testable
      // explicitly (the test fires the listener and asserts identify ran
      // exactly once).
    });
    return () => {
      // Some test environments return undefined from addEventListener;
      // optional-chain the remove call so cleanup is always safe.
      sub?.remove?.();
    };
  }, []);

  // ── Filtered species list for the picker ──────────────────────────────────
  // Plain controlled <TextInput> + on-render filter — small list (<20),
  // documented choice not to debounce (codex P2 risk surface c). At 20
  // entries × O(n) substring match per keystroke, the work is microseconds.
  // If the catalog grows past ~200 entries post-V1, this becomes a
  // useDeferredValue + useMemo question, not a debounce one.
  const filtered = useMemo(() => filterSpecies(filterText), [filterText]);

  // ── Selection handlers ────────────────────────────────────────────────────
  const onSelectCandidate = useCallback(
    (candidate: AddPlantCandidate) => {
      // Use the candidate's slug + label directly (the candidate is the
      // identify result, so its label is what the model emitted; we honor
      // the user's choice). Carry the confidence through so the parent can
      // store it as `plants.identify_confidence`.
      setSelected({
        slug: candidate.slug,
        label: candidate.label,
        confidence: candidate.confidence,
      });
    },
    [],
  );

  const onSelectFromPicker = useCallback((entry: SpeciesEntry) => {
    // Manual picker has no confidence — leave undefined. The DB column is
    // nullable; the parent's create() call will pass null for it.
    setSelected({ slug: entry.slug, label: entry.label });
  }, []);

  const onTapPickFromList = useCallback(() => {
    setView('picker');
  }, []);

  const onSubmit = useCallback(async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const finalUri = compressed?.uri ?? photoUri;
      // nickname forwarded verbatim. Empty string → key omitted from the
      // payload so the parent doesn't have to special-case `''` vs `null`
      // vs missing. Conditional spread instead of `key: undefined` so a
      // strict downstream JSON serializer doesn't see a `nickname:undefined`
      // field that round-trips to `null`.
      const rawNickname = nickname; // intentionally NOT trimmed: preserve user input
      const payload: AddPlantSavePayload = {
        species_slug: selected.slug,
        species_label: selected.label,
        photoUri: finalUri,
        ...(selected.confidence !== undefined
          ? { identify_confidence: selected.confidence }
          : {}),
        ...(rawNickname === '' ? {} : { nickname: rawNickname }),
      };
      await onSave(payload);
    } finally {
      // Leave saving=true — once onSave resolves, the parent should
      // typically navigate away, so flipping back here is a defensive
      // measure for callers that don't navigate.
      setSaving(false);
    }
  }, [compressed, nickname, onSave, photoUri, saving, selected]);

  // ── Render ────────────────────────────────────────────────────────────────

  const showLoading =
    phase === 'compressing' ||
    phase === 'identifying' ||
    identifyStatus === 'requesting';

  const submitDisabled = !selected || saving || showLoading;

  return (
    <View
      accessibilityLabel="Add plant"
      style={[styles.root, { backgroundColor: theme.colors.bg }]}
      testID={testID}
    >
      {/* Hero photo. Renders even during loading — A-4 mockup keeps it on
          screen the entire time. */}
      <View style={styles.heroWrap}>
        <HeroPhoto
          source={{ uri: compressed?.uri ?? photoUri }}
          aspectRatio={1}
          rounded={24}
          accessibilityLabel="Captured plant photo"
          testID={testID ? `${testID}-hero` : undefined}
        />
      </View>

      {showLoading && (
        <View style={styles.loadingWrap}>
          <DiagnoseLoadingState
            accessibilityLabel="Looking up your plant"
            testID={testID ? `${testID}-loading` : undefined}
          />
        </View>
      )}

      {!showLoading && identifyResult?.kind === 'queued' && (
        <View
          accessibilityRole="alert"
          style={[styles.banner, { borderColor: theme.colors.tan }]}
          testID={testID ? `${testID}-banner-queued` : undefined}
        >
          <Text style={[styles.bannerText, { color: theme.colors.text }]}>
            Saved — will identify when online
          </Text>
        </View>
      )}

      {!showLoading && identifyResult?.kind === 'error' && (
        <View
          accessibilityRole="alert"
          style={[styles.banner, { borderColor: theme.colors.tan }]}
          testID={testID ? `${testID}-banner-error` : undefined}
        >
          <Text style={[styles.bannerText, { color: theme.colors.text }]}>
            I don&apos;t recognize this one yet
          </Text>
        </View>
      )}

      {!showLoading && view === 'candidates' && identifyResult?.kind === 'ok' && (
        <CandidatesView
          candidates={identifyResult.candidates}
          selectedSlug={selected?.slug ?? null}
          onSelectCandidate={onSelectCandidate}
          onTapPickFromList={onTapPickFromList}
          theme={theme}
          headerRef={candidatesHeaderRef}
          testID={testID}
        />
      )}

      {!showLoading && view === 'picker' && (
        <PickerView
          filterText={filterText}
          onChangeFilter={setFilterText}
          filtered={filtered}
          selectedSlug={selected?.slug ?? null}
          onSelectFromPicker={onSelectFromPicker}
          theme={theme}
          headerRef={pickerHeaderRef}
          testID={testID}
        />
      )}

      {!showLoading && (
        <View style={styles.footer}>
          <View style={styles.nicknameWrap}>
            <Text
              style={[styles.label, { color: theme.colors.textMuted }]}
              accessible={false}
            >
              NICKNAME (OPTIONAL)
            </Text>
            <TextInput
              value={nickname}
              onChangeText={setNickname}
              placeholder="e.g. Audrey"
              placeholderTextColor={theme.colors.textMuted}
              accessibilityLabel="Nickname (optional)"
              accessibilityHint="Give your plant a name to use in reminders"
              style={[
                styles.input,
                {
                  borderColor: theme.colors.stroke,
                  color: theme.colors.text,
                  backgroundColor: theme.colors.surface,
                },
              ]}
              testID={testID ? `${testID}-nickname` : undefined}
            />
          </View>
          <EditorialButton
            variant="filled"
            label={
              selected ? `Save as ${selected.label}` : 'Save'
            }
            onPress={onSubmit}
            disabled={submitDisabled}
            loading={saving}
            accessibilityLabel={
              selected ? `Save as ${selected.label}` : 'Save plant'
            }
            testID={testID ? `${testID}-submit` : undefined}
          />
          {onCancel && (
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel and go back"
              hitSlop={8}
              style={styles.cancelLink}
              testID={testID ? `${testID}-cancel` : undefined}
            >
              <Text style={[styles.cancelText, { color: theme.colors.textMuted }]}>
                Cancel
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Subviews ──────────────────────────────────────────────────────────────

type CandidatesViewProps = {
  candidates: ReadonlyArray<AddPlantCandidate>;
  selectedSlug: string | null;
  onSelectCandidate: (c: AddPlantCandidate) => void;
  onTapPickFromList: () => void;
  theme: ReturnType<typeof useTheme>;
  /** Forwarded ref so the screen can move screen-reader focus to this header on view swap. */
  headerRef?: React.MutableRefObject<Text | null>;
  testID?: string;
};

function CandidatesView({
  candidates,
  selectedSlug,
  onSelectCandidate,
  onTapPickFromList,
  theme,
  headerRef,
  testID,
}: CandidatesViewProps): ReactElement {
  return (
    <View style={styles.candidatesWrap} testID={testID ? `${testID}-candidates` : undefined}>
      <Text
        ref={headerRef as unknown as React.Ref<Text>}
        style={[
          styles.prompt,
          { color: theme.colors.text, fontFamily: fonts.display.semibold },
        ]}
        accessibilityRole="header"
        // Live region announces the new header when the view swaps from
        // loading → candidates so VoiceOver/TalkBack users hear the
        // transition rather than land silently on a stale element. Codex P2
        // (e) — accessibility focus handoff across loading → results swap.
        // Combined with `setAccessibilityFocus` in the parent useEffect to
        // both announce and move focus.
        accessibilityLiveRegion="polite"
      >
        Is this your plant?
      </Text>
      {candidates.map((c) => {
        const isSelected = selectedSlug === c.slug;
        return (
          <Pressable
            key={c.slug}
            onPress={() => onSelectCandidate(c)}
            accessibilityRole="button"
            accessibilityLabel={`${c.label}, ${c.confidence} percent confident`}
            accessibilityState={{ selected: isSelected }}
            style={[
              styles.candidateCard,
              {
                borderColor: isSelected ? theme.colors.text : theme.colors.stroke,
                borderWidth: isSelected ? 2 : 1,
                backgroundColor: theme.colors.surface,
              },
            ]}
            testID={testID ? `${testID}-candidate-${c.slug}` : undefined}
          >
            <Text
              style={[
                styles.candidateLabel,
                { color: theme.colors.text, fontFamily: fonts.display.semibold },
              ]}
            >
              {c.label}
            </Text>
            <Text
              style={[
                styles.candidateConfidence,
                { color: theme.colors.textMuted, fontFamily: fonts.body.medium },
              ]}
            >
              {`${c.confidence}% CONFIDENT`}
            </Text>
          </Pressable>
        );
      })}
      <Pressable
        onPress={onTapPickFromList}
        accessibilityRole="button"
        accessibilityLabel="Pick from list"
        accessibilityHint="Open the manual species picker"
        hitSlop={8}
        style={styles.pickFromListLink}
        testID={testID ? `${testID}-pick-from-list` : undefined}
      >
        <Text style={[styles.pickFromListText, { color: theme.colors.textMuted }]}>
          Pick from list
        </Text>
      </Pressable>
    </View>
  );
}

type PickerViewProps = {
  filterText: string;
  onChangeFilter: (s: string) => void;
  filtered: ReadonlyArray<SpeciesEntry>;
  selectedSlug: string | null;
  onSelectFromPicker: (e: SpeciesEntry) => void;
  theme: ReturnType<typeof useTheme>;
  headerRef?: React.MutableRefObject<Text | null>;
  testID?: string;
};

function PickerView({
  filterText,
  onChangeFilter,
  filtered,
  selectedSlug,
  onSelectFromPicker,
  theme,
  headerRef,
  testID,
}: PickerViewProps): ReactElement {
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SpeciesEntry>) => {
      const isSelected = selectedSlug === item.slug;
      return (
        <Pressable
          onPress={() => onSelectFromPicker(item)}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          accessibilityState={{ selected: isSelected }}
          style={[
            styles.pickerRow,
            {
              borderBottomColor: theme.colors.stroke,
              backgroundColor: isSelected ? theme.colors.surface : 'transparent',
            },
          ]}
          testID={testID ? `${testID}-picker-${item.slug}` : undefined}
        >
          <Text
            style={[
              styles.pickerLabel,
              { color: theme.colors.text, fontFamily: fonts.body.regular },
            ]}
          >
            {item.label}
          </Text>
        </Pressable>
      );
    },
    [onSelectFromPicker, selectedSlug, theme, testID],
  );

  return (
    <View style={styles.pickerWrap} testID={testID ? `${testID}-picker` : undefined}>
      <Text
        ref={headerRef as unknown as React.Ref<Text>}
        style={[
          styles.prompt,
          { color: theme.colors.text, fontFamily: fonts.display.semibold },
        ]}
        accessibilityRole="header"
        // Live region announces the picker header on swap from candidates
        // → picker (or loading → picker for the no_match path) so screen
        // readers hear the new context. Codex P2 (e). Combined with
        // `setAccessibilityFocus` in the parent useEffect to actually move
        // focus, not just announce.
        accessibilityLiveRegion="polite"
      >
        Pick your plant
      </Text>
      <TextInput
        value={filterText}
        onChangeText={onChangeFilter}
        placeholder="Search species…"
        placeholderTextColor={theme.colors.textMuted}
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="Filter species"
        style={[
          styles.input,
          {
            borderColor: theme.colors.stroke,
            color: theme.colors.text,
            backgroundColor: theme.colors.surface,
          },
        ]}
        testID={testID ? `${testID}-filter` : undefined}
      />
      <FlatList
        data={filtered}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        accessibilityLabel="Species list"
        keyboardShouldPersistTaps="handled"
        testID={testID ? `${testID}-list` : undefined}
        ListEmptyComponent={
          <Text
            style={[
              styles.pickerEmpty,
              { color: theme.colors.textMuted, fontFamily: fonts.body.regular },
            ]}
            testID={testID ? `${testID}-empty` : undefined}
          >
            No matches. Try a different search.
          </Text>
        }
        style={styles.pickerList}
      />
    </View>
  );
}

function keyExtractor(entry: SpeciesEntry): string {
  return entry.slug;
}

// ─── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  heroWrap: {
    marginBottom: 16,
  },
  loadingWrap: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  banner: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
  },
  bannerText: {
    fontFamily: fonts.body.medium,
    fontSize: 14,
  },
  candidatesWrap: {
    marginBottom: 16,
  },
  prompt: {
    fontSize: 24,
    lineHeight: 30,
    marginBottom: 12,
  },
  candidateCard: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  candidateLabel: {
    fontSize: 18,
    lineHeight: 24,
  },
  candidateConfidence: {
    fontSize: 11,
    letterSpacing: 0.8,
    marginTop: 4,
    textTransform: 'uppercase',
  },
  pickFromListLink: {
    alignSelf: 'center',
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  pickFromListText: {
    fontFamily: fonts.body.medium,
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  pickerWrap: {
    flex: 1,
    marginBottom: 16,
  },
  pickerList: {
    flexGrow: 0,
    marginTop: 12,
  },
  pickerRow: {
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 44,
    justifyContent: 'center',
  },
  pickerLabel: {
    fontSize: 16,
    lineHeight: 22,
  },
  pickerEmpty: {
    paddingVertical: 16,
    fontSize: 14,
    fontStyle: 'italic',
  },
  footer: {
    marginTop: 'auto',
    paddingBottom: 24,
  },
  nicknameWrap: {
    marginBottom: 12,
  },
  label: {
    fontFamily: fonts.body.medium,
    fontSize: 11,
    letterSpacing: 0.8,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: fonts.body.regular,
    fontSize: 16,
    minHeight: 44,
  },
  cancelLink: {
    alignSelf: 'center',
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  cancelText: {
    fontFamily: fonts.body.medium,
    fontSize: 14,
  },
});
