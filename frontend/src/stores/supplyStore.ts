import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { SupplyIssue, SupplyLot, SupplyLotDraft } from '../types/supply';

interface ManualIssuePayload {
  qty: number;
  operator: string;
  specimenNo: string;
}

interface SupplyState {
  items: SupplyLot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SupplyLotDraft) => Promise<SupplyLot>;
  issue: (id: string, payload: ManualIssuePayload) => Promise<void>;
  upsertLot: (lot: SupplyLot) => void;
  trace: (lotNo: string) => SupplyLot[];
}

export const useSupplyStore = create<SupplyState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.supplies.toArray();
    items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    set({ items, loaded: true });
  },
  async add(draft) {
    const record: SupplyLot = { ...draft, id: newId('sup'), issues: [] };
    await db.supplies.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async issue(id, payload) {
    const next = await db.transaction('rw', db.supplies, async () => {
      const target = await db.supplies.get(id);
      if (!target) throw new Error('材料批次不存在或已删除');
      if (!(payload.qty > 0)) throw new Error('领用数量必须大于 0');
      if (payload.qty > target.qty) {
        throw new Error(`库存不足：批号 ${target.lotNo} 当前仅剩 ${target.qty} ${target.unit}`);
      }

      const issue: SupplyIssue = {
        ...payload,
        id: newId('iss'),
        unit: target.unit,
        issuedAt: Date.now(),
        status: 'issued',
      };
      const updated: SupplyLot = {
        ...target,
        qty: Number((target.qty - payload.qty).toFixed(6)),
        issues: [issue, ...target.issues],
      };
      await db.supplies.put(updated);
      return updated;
    });
    set({ items: get().items.map((it) => (it.id === id ? next : it)) });
  },
  upsertLot(lot) {
    const exists = get().items.some((it) => it.id === lot.id);
    set({
      items: exists
        ? get().items.map((it) => (it.id === lot.id ? lot : it))
        : [...get().items, lot],
    });
  },
  trace(lotNo) {
    if (!lotNo) return get().items;
    return get().items.filter((it) => it.lotNo.includes(lotNo) || it.name.includes(lotNo));
  },
}));
