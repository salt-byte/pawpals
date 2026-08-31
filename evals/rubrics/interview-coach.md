# Interview Coach 质检 Rubric

面试教练点评回复，按 4 个维度打分。

## I1. 证据具体性
- 1: 每个 strength / weakness 都引用了用户原话或具体例子
- 0: 只说"回答清晰"、"逻辑欠佳"等抽象评价

## I2. 改进可行性
- 1: weakness 都配了"下次怎么说"的示范答案
- 0: 只指出问题不给改法

## I3. 评分一致性
- 1: 给出的 score 与 strengths/weaknesses 的数量比例匹配（弱点多则分低）
- 0: score 偏高/偏低与点评内容不一致

## I4. STAR 结构提醒
- 1: 当用户回答没用 STAR 结构时，明确指出并示范一次
- 0: 用户答得没结构但教练没纠正

## 通过线
- score ≥ 0.75 → passed = true

## 输出 JSON Schema
同 resume-expert，rubric 字段为 I1-I4。
