// Offline tests for the runaway-output guard (no network, no Bridge needed).
// Extracts the real function out of server.mjs so the test always exercises
// shipped code. Run: node tests/runaway.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, '..', 'server.mjs'), 'utf8');
const a = src.indexOf('const RUNAWAY_WINDOW = 1600;');
const b = src.indexOf('const hashKey = (msgs)');
if (a < 0 || b < 0) throw new Error('could not locate runawayReason in server.mjs');
const CFG = { runawayGuard: true, maxOutputChars: 200000 };
const runawayReason = new Function('CFG', src.slice(a, b) + '\nreturn runawayReason;')(CFG);

let pass = 0, fail = 0;
const t = (label, text, expectLoop) => {
  const got = !!runawayReason(text);
  const ok = got === expectLoop;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${runawayReason(text) ?? '(not flagged)'}`);
};

const prose = `机器学习是人工智能的一个分支，它让计算机从数据中学习规律。监督学习使用带标签的数据训练模型，常见算法包括线性回归、决策树、支持向量机等。无监督学习则从未标注的数据中发现结构，例如聚类和降维。强化学习通过与环境交互获得奖励信号来优化策略。
深度学习是机器学习的一个子领域，它使用多层神经网络来自动提取特征。卷积神经网络擅长处理图像，循环神经网络适合序列数据，而 Transformer 架构则成为自然语言处理的主流选择。
在实践中，数据质量往往比模型选择更重要。特征工程、数据清洗、交叉验证都是不可或缺的环节。过拟合是常见问题，可以通过正则化、Dropout、早停等技术缓解。`;

// Must NOT be flagged — legitimate varied output.
t('varied long prose', prose.repeat(4) + '结论：综合以上分析，建议先解决数据质量问题。', false);
t('similar-but-distinct code', Array.from({ length: 40 }, (_, i) =>
  `function handler${i}(req, res) {\n  const id = req.params.id;\n  if (!id) return res.status(400).json({ error: 'missing id ${i}' });\n  return res.json({ ok: true, index: ${i} });\n}`).join('\n\n'), false);
t('incremental long list', Array.from({ length: 120 }, (_, i) =>
  `${i + 1}. 第 ${i + 1} 步：完成对应的子任务，并记录结果到日志文件。`).join('\n'), false);
t('padding whitespace', ' '.repeat(5000), false);

// MUST be flagged — runaway output.
t('repetition loop (pseudo tool calls)', '<get_weather>{"city":"北京"}</get_weather>\n'.repeat(400), true);
t('short-period loop', 'abcdefghij'.repeat(2000), true);
t('absurd length', 'x'.repeat(200001), true);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
