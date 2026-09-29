import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore, StockShortageError } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { usePrepProgress } from '../hooks/usePrepProgress';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { MeasureField } from '../components/common/MeasureField';
import { STEP_FIELD_MAP, STEP_TYPES, type StepType } from '../types/procedure';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { makeSketchDataUrl, type PrepPhoto } from '../types/photo';

/** /procedures/new 新建工序节点：选类型动态出字段，序号跳号报错 */
export default function ProcedureForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const specimens = useSpecimenStore((s) => s.items);
  const supplyLots = useSupplyStore((s) => s.items);
  const addProcedure = useProcedureStore((s) => s.add);
  const finish = useProcedureStore((s) => s.finish);
  const rollback = useProcedureStore((s) => s.rollback);

  const [specimenId, setSpecimenId] = useState(params.get('specimenId') ?? specimens[0]?.id ?? '');
  const [stepType, setStepType] = useState<StepType>('清修');
  const [nodeName, setNodeName] = useState('');
  const [seq, setSeq] = useState(1);
  const [tools, setTools] = useState<string[]>([]);
  const [abrasive, setAbrasive] = useState('');
  const [adhesive, setAdhesive] = useState('');
  const [supplyLotId, setSupplyLotId] = useState('');
  const [supplyUseQty, setSupplyUseQty] = useState(1);
  const [adhesiveConc, setAdhesiveConc] = useState(5);
  const [durationMin, setDurationMin] = useState(60);
  const [tempC, setTempC] = useState(22);
  const [rh, setRh] = useState(50);
  const [operator, setOperator] = useState('');
  const [withPhotos, setWithPhotos] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const progress = usePrepProgress(specimenId || undefined);
  const fieldMap = STEP_FIELD_MAP[stepType];
  const nextSeq = progress.list.length === 0 ? 1 : Math.max(...progress.list.map((it) => it.seq)) + 1;

  // 该工序类型可用的胶种批号（台账中实际有货的批次）
  const adhesiveLots = useMemo(
    () => supplyLots.filter((lot) => lot.kind === '胶种' && fieldMap.adhesives.includes(lot.name)),
    [supplyLots, fieldMap],
  );
  const selectedLot = useMemo(
    () => adhesiveLots.find((lot) => lot.id === supplyLotId),
    [adhesiveLots, supplyLotId],
  );

  const specimen = useMemo(() => specimens.find((it) => it.id === specimenId), [specimens, specimenId]);

  const submit = async () => {
    if (!specimenId) {
      setError('请先选择标本');
      return;
    }
    if (!nodeName.trim()) {
      setError('节点名称必填');
      return;
    }
    if (!operator.trim()) {
      setError('责任人必填');
      return;
    }
    const used = progress.list.map((it) => it.seq);
    if (used.includes(seq)) {
      setError(`序号 ${seq} 已被占用，请改用 ${nextSeq}`);
      return;
    }
    if (seq > nextSeq) {
      setError(`序号跳号：当前最大序号为 ${Math.max(0, nextSeq - 1)}，新节点必须用 ${nextSeq}`);
      return;
    }
    if (!Number.isFinite(adhesiveConc) || adhesiveConc < 0 || adhesiveConc > 100) {
      setError('胶液浓度需在 0 ~ 100 % 之间');
      return;
    }
    if (fieldMap.adhesives.length > 0) {
      if (!supplyLotId) {
        setError('该工序需使用胶种，请选择具体批号（确无领用请改选「不领用胶种」）');
        return;
      }
      if (supplyLotId !== 'none') {
        if (!Number.isFinite(supplyUseQty) || supplyUseQty <= 0) {
          setError('实际用量必须大于 0');
          return;
        }
        const lot = supplyLots.find((it) => it.id === supplyLotId);
        if (!lot) {
          setError('所选批号不存在，请重新选择');
          return;
        }
        if (supplyUseQty > lot.qty) {
          setError(`批号 ${lot.lotNo} 现存仅 ${lot.qty} ${lot.unit}，不足本次用量 ${supplyUseQty} ${lot.unit}，已阻止保存`);
          return;
        }
      }
    }

    const useLot = supplyLotId !== 'none' && fieldMap.adhesives.length > 0
      ? supplyLots.find((it) => it.id === supplyLotId)
      : undefined;

    let record;
    try {
      record = await addProcedure({
        specimenId,
        stepType,
        nodeName: nodeName.trim(),
        seq,
        tools,
        abrasive,
        adhesive: fieldMap.adhesives.length > 0 ? (useLot?.name ?? adhesive) : '',
        adhesiveConc: fieldMap.needConc ? adhesiveConc : 0,
        supplyLotId: useLot?.id ?? '',
        supplyLotNo: useLot?.lotNo ?? '',
        supplyUseQty: useLot ? supplyUseQty : 0,
        durationMin,
        tempC,
        rh,
        photoBeforeIds: [],
        photoAfterIds: [],
        operator: operator.trim(),
        startedAt: Date.now(),
        state: 'pending',
      });
    } catch (err) {
      // 事务内最后一刻发现库存不足（例如多标签页并发），同样当场阻止保存
      if (err instanceof StockShortageError) {
        setError(`${err.message}，已阻止保存，请核实现场用量或更换批号`);
        return;
      }
      setError('节点保存失败，请重试');
      return;
    }

    if (withPhotos && specimen) {
      const before: PrepPhoto = {
        id: newId('pho'),
        specimenId,
        procedureId: record.id,
        stage: 'before',
        caption: `${nodeName.trim()} · 修复前（${specimen.specimenNo}）`,
        dataUrl: makeSketchDataUrl(`修复前 · ${specimen.specimenNo}`, '#6b5844'),
        capturedAt: Date.now(),
      };
      const after: PrepPhoto = {
        id: newId('pho'),
        specimenId,
        procedureId: record.id,
        stage: 'after',
        caption: `${nodeName.trim()} · 修复后（${specimen.specimenNo}）`,
        dataUrl: makeSketchDataUrl(`修复后 · ${specimen.specimenNo}`, '#3f5a4a'),
        capturedAt: Date.now() + 1,
      };
      await db.photos.bulkPut([before, after]);
    }

    setError('');
    setToast(
      useLot
        ? `已追加工序节点 #${seq} ${stepType} · ${record.nodeName}，批号 ${useLot.lotNo} 扣减 ${supplyUseQty} ${useLot.unit}`
        : `已追加工序节点 #${seq} ${stepType} · ${record.nodeName}`,
    );
    setNodeName('');
    setTools([]);
    setSupplyLotId('');
    setSupplyUseQty(1);
    setSeq(nextSeq + 1);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h5" fontWeight={700}>
          新建工序节点
        </Typography>
        <Chip size="small" variant="outlined" label={`建议序号 ${nextSeq}`} />
        <Chip size="small" variant="outlined" label={`现有节点 ${progress.total} 个`} />
        <Box sx={{ flex: 1 }} />
        <Button onClick={() => navigate(`/specimens/${specimenId}`)} disabled={!specimenId}>
          查看标本详情
        </Button>
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 420px' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            {error ? <Alert severity="error" data-testid="procedure-error">{error}</Alert> : null}
            <TextField
              select
              size="small"
              label="标本"
              value={specimenId}
              onChange={(e) => {
                setSpecimenId(e.target.value);
                setSeq(1);
              }}
            >
              {specimens.map((it) => (
                <MenuItem key={it.id} value={it.id}>
                  {it.specimenNo} · {it.taxon}
                </MenuItem>
              ))}
            </TextField>

            <Stack direction="row" spacing={1.5}>
              <TextField
                select
                size="small"
                fullWidth
                label="工序类型"
                value={stepType}
                onChange={(e) => {
                  const next = e.target.value as StepType;
                  setStepType(next);
                  setTools([]);
                  setAbrasive('');
                  setAdhesive('');
                  setSupplyLotId('');
                  setSupplyUseQty(1);
                }}
              >
                {STEP_TYPES.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                fullWidth
                label="节点名称"
                required
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
              />
              <Box sx={{ width: 120 }}>
                <MeasureField
                  label="序号"
                  unit="seq"
                  min={1}
                  max={999}
                  step={1}
                  value={seq}
                  onChange={setSeq}
                  hint={`不得跳号，建议 ${nextSeq}`}
                />
              </Box>
            </Stack>

            {fieldMap.tools.length > 0 ? (
              <TextField
                select
                size="small"
                label="使用工具"
                SelectProps={{ multiple: true }}
                value={tools}
                onChange={(e) => {
                  const v = e.target.value;
                  setTools(typeof v === 'string' ? v.split(',') : v);
                }}
                helperText="气动笔 / 剔针 / 超声波 等，可多选"
              >
                {fieldMap.tools.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <Alert severity="info">该工序类型无需工具清单</Alert>
            )}

            {fieldMap.abrasives.length > 0 ? (
              <TextField
                select
                size="small"
                label="磨料目数"
                value={abrasive}
                onChange={(e) => setAbrasive(e.target.value)}
              >
                <MenuItem value="">不适用</MenuItem>
                {fieldMap.abrasives.map((a) => (
                  <MenuItem key={a} value={a}>
                    {a}
                  </MenuItem>
                ))}
              </TextField>
            ) : null}

            {fieldMap.adhesives.length > 0 ? (
              <Stack spacing={1}>
                <Stack direction="row" spacing={1.5}>
                  <TextField
                    select
                    size="small"
                    fullWidth
                    label="胶种批号（保存时按批号扣减台账）"
                    value={supplyLotId}
                    onChange={(e) => {
                      setSupplyLotId(e.target.value);
                      setSupplyUseQty(1);
                    }}
                  >
                    <MenuItem value="">请选择批号</MenuItem>
                    <MenuItem value="none">不领用胶种（本节点不扣减库存）</MenuItem>
                    {adhesiveLots.map((lot) => (
                      <MenuItem key={lot.id} value={lot.id} disabled={lot.qty <= 0}>
                        {lot.name} · {lot.lotNo} · 现存 {lot.qty} {lot.unit}
                        {lot.qty <= 0 ? '（无库存）' : ''}
                      </MenuItem>
                    ))}
                  </TextField>
                  {selectedLot ? (
                    <Box sx={{ width: 180 }}>
                      <MeasureField
                        label="实际用量"
                        unit={selectedLot.unit}
                        min={1}
                        max={selectedLot.qty}
                        step={1}
                        value={supplyUseQty}
                        onChange={setSupplyUseQty}
                        hint={`批号现存 ${selectedLot.qty} ${selectedLot.unit}，不足将阻止保存`}
                      />
                    </Box>
                  ) : null}
                  {fieldMap.needConc ? (
                    <Box sx={{ width: 180 }}>
                      <MeasureField
                        label="胶液浓度"
                        unit="%"
                        min={0}
                        max={100}
                        step={0.5}
                        value={adhesiveConc}
                        onChange={setAdhesiveConc}
                      />
                    </Box>
                  ) : null}
                </Stack>
                {adhesiveLots.length === 0 ? (
                  <Alert severity="warning" data-testid="no-adhesive-lot">
                    台账中没有该工序可选的胶种批号，请到「材料台账」登记批次后再保存；如本节点确不领料请选择「不领用胶种」。
                  </Alert>
                ) : selectedLot ? (
                  <Typography variant="caption" color="text.secondary">
                    领用后将在批号 {selectedLot.lotNo} 上扣减 {supplyUseQty || 0} {selectedLot.unit}
                    并留下指向本节点 #{seq} 的领用记录；节点回退时原样退回该批号。
                  </Typography>
                ) : null}
              </Stack>
            ) : null}

            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="耗时"
                  unit="min"
                  min={1}
                  max={1440}
                  step={1}
                  value={durationMin}
                  onChange={setDurationMin}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="环境温度" unit="℃" min={-10} max={60} step={0.5} value={tempC} onChange={setTempC} />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="相对湿度" unit="%" min={0} max={100} step={1} value={rh} onChange={setRh} />
              </Box>
            </Stack>

            <TextField
              size="small"
              label="责任人"
              required
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            />

            <FormControlLabel
              control={<Checkbox checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} />}
              label="同时挂接修复前 / 修复后留痕影像（本地生成）"
            />

            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={submit}>
                保存节点
              </Button>
              <Button onClick={() => navigate('/procedures/new')}>清空重填</Button>
            </Stack>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            该标本现有工序
          </Typography>
          {specimen ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {specimen.specimenNo} · 完成度 {progress.percent}% · 待办{' '}
              {progress.current ? `#${progress.current.seq} ${progress.current.nodeName}` : '无'}
            </Typography>
          ) : null}
          <ProcedureTimeline
            items={progress.list}
            onFinish={async (pid) => {
              await finish(pid);
              setToast('节点已完成');
            }}
            onRollback={async (pid) => {
              await rollback(pid);
              setToast('节点已回退');
            }}
          />
        </Paper>
      </Box>

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
