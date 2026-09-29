import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { useSupplyStore } from './supplyStore';
import type { PrepProcedure, PrepProcedureDraft } from '../types/procedure';
import type { SupplyLot } from '../types/supply';

/** 库存不足：阻止工序保存时抛出，表单据此给出明确提示 */
export class StockShortageError extends Error {
  constructor(
    public lotNo: string,
    public requiredQty: number,
    public remainQty: number,
    public unit: string,
  ) {
    super(`批号 ${lotNo} 在库 ${remainQty} ${unit}，不足本次用量 ${requiredQty} ${unit}`);
    this.name = 'StockShortageError';
  }
}

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: PrepProcedureDraft) => Promise<PrepProcedure>;
  finish: (id: string) => Promise<void>;
  rollback: (id: string, reason?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bySpecimen: (specimenId: string) => PrepProcedure[];
}

/**
 * 回退工序占用的材料：把领用数量原样退回批号，并在领用记录上注明已退回。
 * 必须在 supplies 可写事务内调用；批号已不存在时只更新工序上的追溯信息。
 * 返回更新后的批号列表（供同步内存状态）。
 */
async function returnProcedureMaterials(
  procedure: PrepProcedure,
  txSupplies: typeof db.supplies,
): Promise<SupplyLot[]> {
  const returnedAt = Date.now();
  const updated: SupplyLot[] = [];

  if (procedure.supplyLotId) {
    const lot = await txSupplies.get(procedure.supplyLotId);
    if (lot) {
      let changed = false;
      const issues = lot.issues.map((issue) => {
        if (issue.procedureId === procedure.id && issue.returnedAt === undefined) {
          changed = true;
          return { ...issue, returnedAt };
        }
        return issue;
      });
      if (changed) {
        const next: SupplyLot = { ...lot, qty: lot.qty + (procedure.supplyUseQty ?? 0), issues };
        await txSupplies.put(next);
        updated.push(next);
      }
    }
  }

  return updated;
}

/** 把材料 store 内存状态与最新批号记录对齐 */
function syncSupplyStore(updated: SupplyLot[]): void {
  if (updated.length === 0) return;
  const supplyStore = useSupplyStore.getState();
  const byId = new Map(updated.map((lot) => [lot.id, lot]));
  supplyStore.items = supplyStore.items.map((it) => byId.get(it.id) ?? it);
}

export const useProcedureStore = create<ProcedureState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.procedures.toArray();
    items.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
    set({ items, loaded: true });
  },
  async add(draft) {
    const record: PrepProcedure = { ...draft, id: newId('prc') };

    // 选了批号就要按实际用量扣减库存，工序与领用记录在同一事务里落库
    if (record.supplyLotId && (record.supplyUseQty ?? 0) > 0) {
      const useQty = record.supplyUseQty as number;
      let shortage: StockShortageError | null = null;
      let updatedLot: SupplyLot | null = null;

      await db.transaction('rw', db.procedures, db.supplies, db.specimens, async () => {
        const lot = await db.supplies.get(record.supplyLotId!);
        if (!lot) {
          shortage = new StockShortageError(record.supplyLotNo ?? '未知批号', useQty, 0, '');
          return;
        }
        if (lot.qty < useQty) {
          shortage = new StockShortageError(lot.lotNo, useQty, lot.qty, lot.unit);
          return;
        }
        const specimen = await db.specimens.get(record.specimenId);
        const issue = {
          id: newId('iss'),
          qty: useQty,
          operator: record.operator,
          specimenNo: specimen?.specimenNo ?? '未关联标本',
          issuedAt: Date.now(),
          procedureId: record.id,
          nodeName: record.nodeName,
        };
        updatedLot = { ...lot, qty: lot.qty - useQty, issues: [issue, ...lot.issues] };
        await db.supplies.put(updatedLot);
        await db.procedures.put(record);
      });

      if (shortage) throw shortage;
      if (updatedLot) syncSupplyStore([updatedLot]);
    } else {
      await db.procedures.put(record);
    }

    set({ items: [...get().items, record] });
    return record;
  },
  async finish(id) {
    const patch: Partial<PrepProcedure> = { state: 'done', finishedAt: Date.now() };
    await db.procedures.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async rollback(id) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;

    // 节点回退：占用材料原样退回批号，领用记录注明已退回；无材料占用则只改工序状态
    let updatedLots: SupplyLot[] = [];
    if (target.supplyLotId && (target.supplyUseQty ?? 0) > 0) {
      await db.transaction('rw', db.procedures, db.supplies, async () => {
        updatedLots = await returnProcedureMaterials(target, db.supplies);
        await db.procedures.update(id, { state: 'rolledback', finishedAt: undefined });
      });
    } else {
      await db.procedures.update(id, { state: 'rolledback', finishedAt: undefined });
    }

    const patch: Partial<PrepProcedure> = { state: 'rolledback', finishedAt: undefined };
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
    syncSupplyStore(updatedLots);
  },
  async remove(id) {
    const target = get().items.find((it) => it.id === id);
    if (target) {
      // 删除已领料节点同样退回占用材料，避免台账数量丢失
      let updatedLots: SupplyLot[] = [];
      await db.transaction('rw', db.procedures, db.supplies, async () => {
        updatedLots = await returnProcedureMaterials(target, db.supplies);
        await db.procedures.delete(id);
      });
      syncSupplyStore(updatedLots);
    } else {
      await db.procedures.delete(id);
    }
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
