# 正则可视化调试器（Regex Visualizer & Debugger）

一个完全在浏览器里跑的正则教学/调试工具。输入一条正则，它会：

1. **实时解析** 成 AST，侧边栏以可展开树形结构展示，悬停节点联动高亮正则片段；语法错误在出错字符处定位并说明原因；
2. **Thompson 构造** 把 AST 逐规则搭成 NFA（状态/双圈接受态/字符与 ε 转移），可一条规则一条规则地单步播放，也可一键构造完；
3. **子集构造** 把 NFA 状态集合逐个合并成 DFA 状态，新状态高亮，字符集按 minterm 划分成符号，状态数超过上限（默认 256）时截断并提示；
4. **最小化** 用等价类划分细化合并 DFA，动画标出每一轮分裂与最终合并，并给出前后状态数对比；
5. **匹配逐帧放电影**：NFA 模式高亮“当前所有活跃状态集合”，DFA 模式高亮唯一当前状态，被消费字符在输入串里同步高亮；回溯引擎把回退路径画成**红色虚线**；
6. 播放/暂停/单步前进/单步后退/进度跳转/0.5×–8× 倍速一应俱全；
7. **性能面板** 统计转移次数、边尝试数、回溯次数、访问状态总数，识别平方级/指数级（灾难性）回溯并给出改写建议；
8. 同一条正则、同一个串可**左右并排对比贪婪与懒惰**两条轨迹；
9. 内置邮箱、URL、日期、HTML 标签、灾难性回溯、**重复单词（反向引用）**、
   **HTML 同名闭合标签（命名组 + `\k<name>`）**等分步讲解教学案例；
10. **诚实标注能力边界**：含反向引用的模式无法用有限状态机表示，NFA/DFA/最小化
    三段自动机明确显示“不可确定化”并点名原因，匹配引擎只开放回溯，不偷偷产出
    语义错误的自动机；回溯回放中反向引用取值与逐字符比对以紫色单独成帧。

> 核心设计原则：**前端展示的每一步都来自后端引擎的确定结果**。前端不做任何引擎推导，
> NFA、子集构造 DFA、最小化 DFA、回溯引擎对任意串的接受/拒绝结论必须完全一致——
> `/api/compile` 每次都会跑一组一致性自检并在界面上显示结果。

---

## 支持的正则子集

| 特性 | 示例 |
| --- | --- |
| 字面字符 | `abc` |
| 字符类：区间 / 取反 / 预定义类 | `[a-z]`、`[^0-9]`、`[\w.-]`、`\d` `\w` `\s`（及大写 `\D \W \S`）、`.` |
| 量词 | `*` `+` `?` `{n}` `{n,}` `{n,m}`，后接 `?` 切懒惰，如 `a+?`、`\d{2,4}?` |
| 分组 | 捕获组 `(...)`（自动编号）、非捕获组 `(?:...)`、命名捕获组 `(?<name>...)` |
| 反向引用 | 数字 `\1`、具名 `\k<name>`（**不是正则语言**，见下节） |
| 选择分支 | `ab|cd`、`a|b|c`（允许空分支） |
| 锚点 | `^` 行首、`$` 行尾 |
| 转义 | `\.` `\+` `\\` `\t` `\n` `\r` `\f` `\v` 等 |

### 命名捕获组与反向引用（超出正则语言的部分）

- 组名规则：非空、以字母或下划线开头、其后为字母/数字/下划线，且全模式唯一；
  非法组名、重名、`\N`/`\k<name>` 指向不存在或尚未闭合的分组（自引用 / 前向引用）
  都在**解析阶段**定位到括号或反向引用位置直接报错，不会留到运行时陷入死循环。
- 反向引用要求“接下来读到的文本与某分组之前抓到的内容逐字相同”，这是依赖
  **记忆**的比较，属于 `ww` 型非正则现象：NFA/DFA 的状态无法保存任意长度的
  已捕获文本。因此凡含反向引用的模式：
  - **NFA（Thompson）、子集 DFA、最小化三个阶段一律不构造**，界面三栏明确进入
    “不可确定化”状态，点名是哪个/哪些反向引用导致的，并解释原因；
  - NFA 子集模拟 / DFA / 最小 DFA 三个匹配引擎不可选用（接口对这类请求返回
    `409 EngineUnavailableError`），只有**回溯引擎**可执行——它直接在 AST 上
    运行，从捕获栈取文本逐字符比对，失配即普通路径回溯；
  - “三机结论一致”自检对这类模式标记为“不适用”（`applicable:false`），
    而不是拿一台语义错误的自动机去偷偷通过校验。
  - 不含反向引用的模式（包括只用命名捕获组）流水线与校验**完全不变**。
- **捕获约定（与 JS/ECMA-262 一致，界面逐帧标注）**：被引用分组在当前路径
  - *未参与匹配*（例如在没走到的另一选择分支里）时，反向引用按**本次比对失败**
    处理（紫色 `backref-unset` 帧）；分组参与过但抓到*空串*（典型如 `(x)?` 被
    跳过的一次）时，反向引用要求匹配零个字符，**零宽通过**（`backref-empty`
    帧）。逐帧回放把反向引用单独成帧：`取值 → 逐字符比对（绿/红）→ 通过/失败`。

常见语法错误（括号未闭合、字符类未闭合、`{3,2}` 非法范围、区间颠倒、量词无对象、
未知转义等）都会在**出错位置**给出标记和中文原因。

匹配语义：在串中寻找**最左**匹配；贪婪取该起点的**最长**结果，懒惰取**最短**。

---

## 技术栈与模块划分

- **后端**：Node.js 20 + Express（ESM）。引擎全部独立成模块，互不依赖前端：

  ```
  server/src/
    parser/lexer.js         词法：字符类/预定义类/量词/转义/命名组/反向引用，带位置的语法错误
    parser/ast.js           AST 节点工厂（每个节点带源码 [pos,end) 区间）
    parser/parser.js        递归下降语法分析（命名组编号、反向引用自/前向引用解析期校验）
    features.js             AST 遍历：反向引用探测（决定自动机链路是否可用）
    charset.js              区间字符集：并/补/交、minterm 布尔划分、展示
    nfa/thompson.js         Thompson 构造 + 层次布局 + 构造步骤录制
    nfa/nfa-ops.js          ε-闭包（含 ^/$ 位置条件与接受依赖）
    dfa/subset.js           子集构造（minterm 字母表、死状态、截断、步骤录制）
    dfa/minimize.js         等价类划分细化最小化 + 合并步骤录制
    match/backtracker.js    回溯 DFS（NFA 版：贪婪最长/懒惰最短、捕获组、回溯帧、步数上限）
    match/ast-backtracker.js 回溯 DFS（AST 版：命名组 + 反向引用、捕获栈、backref 专用帧）
    match/nfa-sim.js        NFA 子集模拟（活跃状态集合，不回溯）
    match/dfa-sim.js        DFA 确定性模拟（唯一当前状态，不回溯）
    analysis/catastrophic.js 静态结构扫描（含反向引用爆炸源）+ 经验探针 + 改写建议
    examples/index.js       教学案例
    consistency.js          三套自动机一致性校验
    compile.js              流水线编排
    app.js / server.js      Express 接口 + 静态托管
  ```

- **前端**：React 18 + Vite，状态机用**原生 Canvas**绘制：

  ```
  client/src/
    state/api.js            唯一的后端通信层
    canvas/graphLayout.js   逻辑层位 -> 画布像素
    canvas/GraphCanvas.jsx  通用画布（缩放/平移/悬停、ε 虚线、回溯红虚线、双圈）
    components/PatternInput.jsx     实时解析、错误定位标记、片段高亮
    components/AstTree.jsx          可展开 AST 树，悬停联动
    components/ConstructionPlayer.jsx  NFA/DFA/最小化构造动画
    components/MatchPlayer.jsx      匹配逐帧动画、输入字符高亮
    components/PlayerControls.jsx   播放/暂停/单步/进度/倍速
    components/PerfPanel.jsx        性能统计与灾难性回溯分析
    components/ModeCompare.jsx      贪婪/懒惰并排对比
    components/ExamplesBar.jsx      教学案例与分步讲解
    App.jsx
  ```

---

## 快速开始（开发模式）

需要 Node.js 20。

```bash
# 安装两端依赖
npm run install:all

# 终端 1：后端（http://localhost:3000）
npm run dev:server

# 终端 2：前端 Vite 开发服务器（http://localhost:5173，/api 已代理到 3000）
npm run dev:client
```

打开 http://localhost:5173 即可。

## 生产模式（单进程）

```bash
npm run build      # 前端构建到 server/public
npm start          # Express 在 3000 端口同时提供 API 与前端静态资源
```

浏览器打开 http://localhost:3000 ，无需另起任何前端进程。

## 容器（推荐分发方式）

基础镜像 `node:20-slim`，前端构建与后端运行时都锁定 Node.js 20：

```bash
docker compose up --build
# 或
docker build -t regex-visualizer .
docker run --rm -p 3000:3000 regex-visualizer
```

打开 http://localhost:3000 即可使用。

---

## HTTP 接口

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /api/parse` | `{pattern}` → AST（输入框实时调用，错误带 position/length） |
| `POST /api/compile` | `{pattern, dfaLimit, verifyStrings[]}` → AST + NFA + DFA + 最小 DFA + 一致性自检；含反向引用时三图为 `null`，`nonDeterminizable`/`backrefs` 说明原因 |
| `POST /api/match` | `{pattern, input, engine, mode}`，engine ∈ `backtracking/nfa/dfa/minDFA`，mode ∈ `greedy/lazy`；返回逐帧 frames 与指标。含反向引用时只允许 `backtracking`，其余引擎返回 409 |
| `POST /api/compare-modes` | 同串的贪婪 / 懒惰两套回溯轨迹 |
| `POST /api/analyze` | 灾难性回溯静态分析 + 经验探针 + 改写建议 |
| `GET /api/examples`、`GET /api/examples/:id` | 教学案例列表与详情（含分步讲解） |
| `GET /api/health` | 版本与状态上限 |

## 自动化测试

基于 Node 内置测试运行器（`node --test`），无需额外测试框架：

```bash
npm test
```

覆盖四块：

- **正则解析**（`parser.test.js`）：全部语法元素 + 各类错误的位置与原因；
- **三种自动机一致性**（`automata.test.js`）：NFA / 子集 DFA / 最小 DFA / 回溯引擎
  在数百个“正则 × 输入”组合上接受结论与贪婪匹配区间完全一致，锚点、死状态、截断、最小化合并等；
- **匹配与回溯**（`match-backtrack.test.js`）：帧序列、贪婪/懒惰长短、回溯计数、
  捕获组（含嵌套）、零宽环保护、步数上限；
- **灾难性回溯检测**（`catastrophic.test.js`）：`(a+)+`、`(a|aa)+`、`a*a*` 等
  静态识别，以及经验探针对指数/线性增长的分级；
- **命名捕获组与反向引用**（`backreference.test.js`）：组名校验/重名、自引用与
  前向引用解析期拒绝、数字与具名反向引用的正确匹配与失败、未参与/空串捕获约定、
  含反向引用模式自动机三段被明确拒绝、无反向引用模式链路不受影响、新教学案例正确性；
- 另有 **HTTP 端到端测试**（`api.test.js`）直接起 Express 走真实 fetch。

---

## 实现上的几个关键约定

- **字符集即字母表**：DFA 不穷举字符，而对 NFA 上出现过的字符集做 minterm 布尔划分；
  每个原子区间内转移完全一致，BMP 之外字符归入“其他”符号（进死状态）。
- **锚点是带位置条件的 ε 边**：闭包按“是否串首/串尾”分别计算，DFA 状态记录接受态
  是“无条件可达”还是“仅在串首/串尾可达”，模拟时按真实位置判定，避免 `^$` 误匹配。
- **贪婪/懒惰只差选择边顺序**：量词展开出 `continue` / `exit` 两条 ε 选择边，
  回溯引擎贪婪先 continue，惰性先 exit；图结构完全相同，因此两者接受/拒绝结论恒一致，
  只有匹配跨度（贪婪最长、懒惰最短）的差别。
- **NFA 布局**：最长路径定 x 层、重心迭代排序定 y，起始在左、接受在右，不重叠。
- **防爆炸护栏**：NFA 状态上限 4000，DFA 默认 256（界面可调，最高 4096），
  回溯步数上限 200000、帧数上限 14000；危险结构长输入会被安全终止而不是挂死页面。
