/**
 * wateringEventsBus tests (E4-006).
 *
 * Tiny module-level pub/sub. Tests pin the listener-registration
 * semantics, the snapshot-during-emit behavior (a self-unsubscribing
 * listener doesn't shift iteration), and the per-event-kind shape.
 */
import { wateringEventsBus, type WateringBusEvent } from '../wateringEvents';

beforeEach(() => {
  wateringEventsBus._resetForTests();
});

describe('wateringEventsBus', () => {
  it('subscribe + emit delivers the event to the listener', () => {
    const seen: WateringBusEvent[] = [];
    wateringEventsBus.subscribe((e) => seen.push(e));
    wateringEventsBus.emitOptimistic('plant-1', 1000);
    expect(seen).toEqual([{ kind: 'optimistic', plantId: 'plant-1', wateredAtMs: 1000 }]);
  });

  it('multiple listeners all receive the event', () => {
    const seen1: WateringBusEvent[] = [];
    const seen2: WateringBusEvent[] = [];
    wateringEventsBus.subscribe((e) => seen1.push(e));
    wateringEventsBus.subscribe((e) => seen2.push(e));
    wateringEventsBus.emitCommit('plant-1');
    expect(seen1.length).toBe(1);
    expect(seen2.length).toBe(1);
  });

  it('unsubscribe stops delivery to that listener', () => {
    const seen: WateringBusEvent[] = [];
    const unsubscribe = wateringEventsBus.subscribe((e) => seen.push(e));
    wateringEventsBus.emitCommit('plant-1');
    unsubscribe();
    wateringEventsBus.emitCommit('plant-2');
    expect(seen.map((e) => (e.kind === 'commit' ? e.plantId : null))).toEqual(['plant-1']);
  });

  it('a listener that unsubscribes itself mid-emit does not shift iteration', () => {
    const seen: string[] = [];
    let unsub1: (() => void) | null = null;
    unsub1 = wateringEventsBus.subscribe(() => {
      seen.push('a');
      unsub1?.();
    });
    wateringEventsBus.subscribe(() => {
      seen.push('b');
    });
    wateringEventsBus.emitCommit('plant-1');
    expect(seen).toEqual(['a', 'b']);
  });

  it('a throwing listener does not break the emitter or other listeners', () => {
    const seen: string[] = [];
    wateringEventsBus.subscribe(() => {
      throw new Error('boom');
    });
    wateringEventsBus.subscribe(() => {
      seen.push('survivor');
    });
    expect(() => wateringEventsBus.emitCommit('plant-1')).not.toThrow();
    expect(seen).toEqual(['survivor']);
  });

  it('emit shapes — optimistic carries wateredAtMs; commit/rollback do not', () => {
    const seen: WateringBusEvent[] = [];
    wateringEventsBus.subscribe((e) => seen.push(e));
    wateringEventsBus.emitOptimistic('p1', 5000);
    wateringEventsBus.emitCommit('p1');
    wateringEventsBus.emitRollback('p1');
    expect(seen).toEqual([
      { kind: 'optimistic', plantId: 'p1', wateredAtMs: 5000 },
      { kind: 'commit', plantId: 'p1' },
      { kind: 'rollback', plantId: 'p1' },
    ]);
  });

  it('_resetForTests drops all subscribers', () => {
    const seen: WateringBusEvent[] = [];
    wateringEventsBus.subscribe((e) => seen.push(e));
    wateringEventsBus._resetForTests();
    wateringEventsBus.emitCommit('p1');
    expect(seen).toEqual([]);
  });
});
