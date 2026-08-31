# Resume Expert 质检 Rubric

简历专家产出的回复，按以下 4 个维度逐项打分（每项 0 或 1），加总得 score (0-1.0)。

## R1. JD 引用度
- 1: 引用了 JD 至少 2 个具体技能/关键词（如 "SQL"、"A/B 测试"、"Agentic workflows"）
- 0: 没有引用 JD，或只用泛词（"产品能力"、"沟通能力"）

## R2. 可执行性
- 1: 给出了**可直接 copy 到简历的改写文本**（具体句子、数字、项目名）
- 0: 只给了方向性建议（"建议突出"、"可以强调"）

## R3. 避免空话
- 1: 没有出现以下空话句式
- 0: 出现了 "建议突出你的优势" / "可以更好地展示" / "适当增加"

## R4. 覆盖薄弱项
- 1: 覆盖了 profile.md 或 skills_gap.md 里标注的薄弱项至少 1 个
- 0: 完全没碰薄弱项

## 通过线
- score ≥ 0.75 → passed = true
- score < 0.75 → passed = false，issues 写明哪几项 = 0

## 输出 JSON Schema
```json
{
  "passed": true,
  "score": 0.75,
  "rubric": { "R1": 1, "R2": 1, "R3": 1, "R4": 0 },
  "issues": ["R4: 未覆盖 profile 中标注的 SQL 薄弱项"],
  "evidence_quotes": ["原回复里引用 JD 的句子"]
}
```
