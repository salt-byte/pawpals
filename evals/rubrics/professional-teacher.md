# Professional Teacher 质检 Rubric

专业老师做的方向定位 / JD 分析回复，按 4 个维度打分。

## P1. 数据支撑
- 1: 引用了具体岗位需求、市场数据或 profile 中的事实
- 0: 仅凭 LLM 通识泛泛而谈

## P2. 路径具体
- 1: 给出了"现在缺什么 → 怎么补 → 多久"的可执行路径
- 0: 只给方向不给步骤

## P3. 区分度
- 1: 在多个候选方向之间做了明确比较（A 适合 X，B 适合 Y）
- 0: 没有比较，列了一堆方向不分主次

## P4. 与 profile 对齐
- 1: 推断的方向与 profile.md 里的目标岗位、技能、求职类型一致
- 0: 推断方向与 profile 明显冲突

## 通过线
- score ≥ 0.75 → passed = true

## 输出 JSON Schema
同 resume-expert，rubric 字段为 P1-P4。
