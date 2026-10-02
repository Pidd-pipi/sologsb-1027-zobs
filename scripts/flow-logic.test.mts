import {
  applyFlowInvalidation,
  backfillFlowRelations,
  downstreamOf,
  invalidateSteps,
  normalizeProcess
} from '../src/App';

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${name}`, extra === undefined ? '' : JSON.stringify(extra, null, 2));
  }
}

function makeStep(partial: Record<string, unknown>): any {
  return {
    id: 's', title: partial.id ?? '步骤', purpose: '', materials: '', equipment: '', amount: '1 g',
    duration: 10, hazards: [], controls: '', dependencies: [], safetyNote: '', expectedResult: '',
    outputName: '', outputBatch: '', consumesFrom: [], invalidation: null,
    flowPending: false, flowMigrated: true, status: 'confirmed', comments: [],
    ...partial
  };
}
function makeProcess(steps: any[]): any {
  return {
    id: 'p', title: '', code: '', objective: '', principal: '', lab: '',
    status: 'in-review', version: '1.0.0', steps, versions: [], updatedAt: ''
  };
}

console.log('1. 上游批次/用量/产出名称变化 → 消耗步骤及下游复核失效');
{
  const steps = [
    makeStep({ id: 'A', title: '上游', outputName: '中间体', outputBatch: 'B1', status: 'confirmed' }),
    makeStep({ id: 'B', title: '消费者', consumesFrom: ['A'], dependencies: ['A'], status: 'confirmed' }),
    makeStep({ id: 'C', title: '下游', dependencies: ['B'], status: 'submitted' }),
    makeStep({ id: 'D', title: '无关', status: 'confirmed' })
  ];
  const draft = makeProcess(steps);
  applyFlowInvalidation(draft, 'A', '批次');
  check('消费者 B 失效', steps[1].status === 'invalidated');
  check('下游 C 级联失效', steps[2].status === 'invalidated');
  check('无关步骤 D 不受影响', steps[3].status === 'confirmed');
  check('失效保留原确认状态', steps[1].invalidation?.previousStatus === 'confirmed');
  check('失效保留原因且含上游名称', JSON.stringify(steps[1].invalidation?.reason).includes('上游') && JSON.stringify(steps[1].invalidation?.reason).includes('批次'));
  check('C 的原状态是 submitted', steps[2].invalidation?.previousStatus === 'submitted');
}

console.log('2. 已失效步骤再次被波及 → 保留最初的原确认和原因');
{
  const steps = [
    makeStep({ id: 'A', title: '上游', status: 'confirmed' }),
    makeStep({ id: 'B', title: '消费者', consumesFrom: ['A'], status: 'confirmed' })
  ];
  const draft = makeProcess(steps);
  applyFlowInvalidation(draft, 'A', '批次');
  const firstReason = steps[1].invalidation.reason;
  const firstAt = steps[1].invalidation.at;
  applyFlowInvalidation(draft, 'A', '用量');
  check('原因不被覆盖', steps[1].invalidation.reason === firstReason);
  check('时间不被覆盖', steps[1].invalidation.at === firstAt);
  check('状态仍为 invalidated', steps[1].status === 'invalidated');
}

console.log('3. 草稿/已退回步骤不产生失效记录');
{
  const steps = [
    makeStep({ id: 'A', status: 'confirmed' }),
    makeStep({ id: 'B', consumesFrom: ['A'], status: 'draft' }),
    makeStep({ id: 'C', consumesFrom: ['A'], status: 'returned' })
  ];
  applyFlowInvalidation(makeProcess(steps), 'A', '用量');
  check('草稿不受影响', steps[1].status === 'draft' && steps[1].invalidation === null);
  check('已退回不受影响', steps[2].status === 'returned' && steps[2].invalidation === null);
}

console.log('4. 无消费者时无失效');
{
  const steps = [makeStep({ id: 'A', status: 'confirmed' }), makeStep({ id: 'B', dependencies: ['A'], status: 'confirmed' })];
  applyFlowInvalidation(makeProcess(steps), 'A', '批次');
  check('仅依赖不消耗 → 不失效（由影响提醒覆盖）', steps[1].status === 'confirmed');
}

console.log('5. downstreamOf 同时遍历依赖与消耗边');
{
  const steps = [
    makeStep({ id: 'A' }),
    makeStep({ id: 'B', consumesFrom: ['A'] }),
    makeStep({ id: 'C', dependencies: ['B'] }),
    makeStep({ id: 'D', consumesFrom: ['C'] })
  ];
  const result = downstreamOf(steps, ['A']);
  check('沿消耗+依赖传播到 D', ['A', 'B', 'C', 'D'].every((id) => result.has(id)), [...result]);
}

console.log('6. 旧草稿迁移：唯一前置 → 接上流转关系，旧结论保留');
{
  const old: any = {
    id: 'p', title: '', code: '', objective: '', principal: '', lab: '', status: 'in-review',
    version: '1.0.0', updatedAt: '', versions: [],
    steps: [
      { id: 's1', title: '一', dependencies: [], status: 'confirmed', hazards: [], comments: [] },
      { id: 's2', title: '二', dependencies: ['s1'], status: 'confirmed', hazards: [], comments: [] }
    ]
  };
  const p = normalizeProcess(old);
  backfillFlowRelations(p);
  check('s2 消耗来源补为 s1', p.steps[1].consumesFrom.join() === 's1');
  check('s2 不列为待整理', p.steps[1].flowPending === false);
  check('s2 旧确认保留', p.steps[1].status === 'confirmed' && p.steps[1].invalidation === null);
  check('迁移标记已写入', p.steps.every((s: any) => s.flowMigrated));
}

console.log('7. 旧草稿迁移：多个前置无法唯一对应 → 待整理 + 旧结论不沿用');
{
  const old: any = {
    id: 'p', title: '', code: '', objective: '', principal: '', lab: '', status: 'in-review',
    version: '1.0.0', updatedAt: '', versions: [],
    steps: [
      { id: 's1', dependencies: [], status: 'confirmed', hazards: [], comments: [] },
      { id: 's2', dependencies: [], status: 'confirmed', hazards: [], comments: [] },
      { id: 's3', dependencies: ['s1', 's2'], status: 'confirmed', hazards: [], comments: [] },
      { id: 's4', dependencies: ['s1', 's2'], status: 'submitted', hazards: [], comments: [] }
    ]
  };
  const p = normalizeProcess(old);
  backfillFlowRelations(p);
  check('s3 列为待整理', p.steps[2].flowPending === true);
  check('s3 旧确认不沿用（已失效）', p.steps[2].status === 'invalidated');
  check('s3 失效记录原确认', p.steps[2].invalidation?.previousStatus === 'confirmed');
  check('s3 原因说明待整理', JSON.stringify(p.steps[2].invalidation?.reason).includes('待整理'));
  check('s4 待复核同样不沿用', p.steps[3].status === 'invalidated' && p.steps[3].invalidation?.previousStatus === 'submitted');
  check('s1/s2 无前置不受影响', p.steps[0].status === 'confirmed' && p.steps[1].status === 'confirmed');
}

console.log('8. 迁移失败 → 恢复原流程（不沿用推断结果）');
{
  const old: any = {
    id: 'p', title: '', code: '', objective: '', principal: '', lab: '', status: 'in-review',
    version: '1.0.0', updatedAt: '', versions: [],
    steps: [{ id: 's1', dependencies: [], status: 'confirmed', hazards: [], comments: [] }]
  };
  // 模拟 loadProcess 的双层 try：backfill 抛错时回退到 normalizeProcess(parsed)
  let restored: any;
  const normalized = normalizeProcess(old);
  try {
    // 人为制造处理失败
    Object.defineProperty(normalized, 'steps', { get() { throw new Error('corrupt'); } });
    backfillFlowRelations(normalized);
    restored = normalized;
  } catch {
    restored = normalizeProcess(old);
  }
  check('回退到原流程数据', restored.steps.length === 1 && restored.steps[0].id === 's1');
  check('原确认状态保留', restored.steps[0].status === 'confirmed');
  check('未写入任何流转结论', restored.steps[0].consumesFrom.length === 0 && restored.steps[0].invalidation === null);
}

console.log('9. invalidateSteps 只影响目标集合');
{
  const steps = [makeStep({ id: 'A', status: 'confirmed' }), makeStep({ id: 'B', status: 'confirmed' })];
  invalidateSteps(steps, new Set(['A']), '测试原因', '', '');
  check('A 失效', steps[0].status === 'invalidated');
  check('B 不受影响', steps[1].status === 'confirmed');
}

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
