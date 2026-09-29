import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { useSupplyStore } from './supplyStore';
import type { ProcedureMaterialUsage, PrepProcedure, PrepProcedureDraft } from '../types/procedure';
import type { SupplyIssue, SupplyLot } from '../types/supply';

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

function assertIssueStock(lot: SupplyLot, qty: number): void {
  if (!(qty > 0)) throw new Error('实际用量必须大于 0');
  if (qty > lot.qty) {
    throw new Error(`库存不足：批号 ${lot.lotNo} 当前仅剩 ${lot.qty} ${lot.unit}`);
  }
}

function buildIssue(
  lot: SupplyLot,
  procedure: PrepProcedure,
  specimenNo: string,
  qty: number,
  id: string,
  issuedAt: number,
): SupplyIssue {
  return {
    id,
    qty,
    unit: lot.unit,
    operator: procedure.operator,
    specimenNo,
    specimenId: procedure.specimenId,
    issuedAt,
    status: 'issued',
    procedureId: procedure.id,
    procedureSeq: procedure.seq,
    nodeName: procedure.nodeName,
    stepType: procedure.stepType,
  };
}

function buildMaterialUsage(lot: SupplyLot, issue: SupplyIssue): ProcedureMaterialUsage {
  return {
    lotId: lot.id,
    lotNo: lot.lotNo,
    materialName: lot.name,
    kind: lot.kind,
    qty: issue.qty,
    unit: issue.unit,
    issueId: issue.id,
    issuedAt: issue.issuedAt,
  };
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
    const { material, ...procedureFields } = draft;
    const { record, updatedLot } = await db.transaction('rw', db.procedures, db.supplies, db.specimens, async () => {
      const specimen = await db.specimens.get(draft.specimenId);
      if (!specimen) throw new Error('标本不存在或已删除');

      const id = newId('prc');
      const now = Date.now();
      const init: PrepProcedure = {
        ...procedureFields,
        id,
        materialUsage: null,
      };

      let updatedLot: SupplyLot | undefined;
      if (material) {
        const lot = await db.supplies.get(material.lotId);
        if (!lot) throw new Error('所选材料批次不存在或已删除');
        if (lot.kind !== '胶种' || lot.name !== draft.adhesive) {
          throw new Error('所选批号与当前胶种不一致，请重新选择');
        }
        assertIssueStock(lot, material.qty);

        const issue = buildIssue(lot, init, specimen.specimenNo, material.qty, newId('iss'), now);
        const materialUsage = buildMaterialUsage(lot, issue);
        const recordWithMaterial: PrepProcedure = { ...init, materialUsage };
        const changedLot: SupplyLot = {
          ...lot,
          qty: Number((lot.qty - material.qty).toFixed(6)),
          issues: [issue, ...lot.issues],
        };
        updatedLot = changedLot;
        await Promise.all([db.procedures.put(recordWithMaterial), db.supplies.put(changedLot)]);
        return { record: recordWithMaterial, updatedLot: changedLot };
      }

      await db.procedures.put(init);
      return { record: init, updatedLot };
    });

    set({ items: [...get().items, record] });
    if (updatedLot) useSupplyStore.getState().upsertLot(updatedLot);
    return record;
  },
  async finish(id) {
    const { record, updatedLot } = await db.transaction('rw', db.procedures, db.supplies, db.specimens, async () => {
      const procedure = await db.procedures.get(id);
      if (!procedure) throw new Error('工序节点不存在或已删除');
      if (procedure.state === 'done') return { record: procedure, updatedLot: undefined };

      let record = { ...procedure, state: 'done', finishedAt: Date.now() } as PrepProcedure;
      let updatedLot: SupplyLot | undefined;

      if (procedure.state === 'rolledback' && procedure.materialUsage) {
        const lot = await db.supplies.get(procedure.materialUsage.lotId);
        if (!lot) throw new Error('原领用批号不存在，无法重新完成节点');

        const oldIssue = lot.issues.find((it) => it.id === procedure.materialUsage?.issueId);
        if (!oldIssue || oldIssue.status !== 'returned') {
          throw new Error('原领用记录已异常，不能重复扣减库存');
        }
        assertIssueStock(lot, procedure.materialUsage.qty);

        const specimen = await db.specimens.get(procedure.specimenId);
        const issue = buildIssue(
          lot,
          record,
          specimen?.specimenNo ?? oldIssue.specimenNo,
          procedure.materialUsage.qty,
          newId('iss'),
          Date.now(),
        );
        const recordWithMaterial: PrepProcedure = { ...record, materialUsage: buildMaterialUsage(lot, issue) };
        record = recordWithMaterial;
        const changedLot: SupplyLot = {
          ...lot,
          qty: Number((lot.qty - issue.qty).toFixed(6)),
          issues: [issue, ...lot.issues],
        };
        updatedLot = changedLot;
      }

      await db.procedures.put(record);
      if (updatedLot) await db.supplies.put(updatedLot);
      return { record, updatedLot };
    });

    set({ items: get().items.map((it) => (it.id === id ? record : it)) });
    if (updatedLot) useSupplyStore.getState().upsertLot(updatedLot);
  },
  async rollback(id) {
    const { record, updatedLot } = await db.transaction('rw', db.procedures, db.supplies, async () => {
      const procedure = await db.procedures.get(id);
      if (!procedure) throw new Error('工序节点不存在或已删除');
      if (procedure.state === 'rolledback') return { record: procedure, updatedLot: undefined };
      if (procedure.state !== 'done') throw new Error('仅已完成节点可以回退');

      const now = Date.now();
      let record: PrepProcedure = { ...procedure, state: 'rolledback', finishedAt: undefined };
      let updatedLot: SupplyLot | undefined;

      if (procedure.materialUsage) {
        const lot = await db.supplies.get(procedure.materialUsage.lotId);
        if (!lot) throw new Error('原领用批号不存在，无法退回材料');
        const issue = lot.issues.find((it) => it.id === procedure.materialUsage?.issueId);
        if (!issue) throw new Error('原领用记录不存在，无法退回材料');
        if (issue.status !== 'issued') throw new Error('该材料已经退回，不能重复退回');

        const returnedIssue: SupplyIssue = { ...issue, status: 'returned', returnedAt: now };
        const changedLot: SupplyLot = {
          ...lot,
          qty: Number((lot.qty + issue.qty).toFixed(6)),
          issues: lot.issues.map((it) => (it.id === issue.id ? returnedIssue : it)),
        };
        updatedLot = changedLot;
        record = {
          ...record,
          materialUsage: { ...procedure.materialUsage, returnedAt: now },
        };
        await db.supplies.put(updatedLot);
      }

      await db.procedures.put(record);
      return { record, updatedLot };
    });

    set({ items: get().items.map((it) => (it.id === id ? record : it)) });
    if (updatedLot) useSupplyStore.getState().upsertLot(updatedLot);
  },
  async remove(id) {
    const updatedLot = await db.transaction('rw', db.procedures, db.supplies, async () => {
      const procedure = await db.procedures.get(id);
      if (!procedure) return undefined;

      let updatedLot: SupplyLot | undefined;
      if (procedure.materialUsage) {
        const lot = await db.supplies.get(procedure.materialUsage.lotId);
        const issue = lot?.issues.find((it) => it.id === procedure.materialUsage?.issueId);
        if (lot && issue && issue.status === 'issued') {
          const returnedIssue: SupplyIssue = { ...issue, status: 'returned', returnedAt: Date.now() };
          const changedLot: SupplyLot = {
            ...lot,
            qty: Number((lot.qty + issue.qty).toFixed(6)),
            issues: lot.issues.map((it) => (it.id === issue.id ? returnedIssue : it)),
          };
          updatedLot = changedLot;
          await db.supplies.put(changedLot);
        }
      }
      await db.procedures.delete(id);
      return updatedLot;
    });

    set({ items: get().items.filter((it) => it.id !== id) });
    if (updatedLot) useSupplyStore.getState().upsertLot(updatedLot);
  },
  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
