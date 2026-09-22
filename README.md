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
9. 内置邮箱、URL、日期、HTML 标签、灾难性回溯等**分步讲解教学案例**。

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
| 分组 | 捕获组 `(...)`（自动编号）、非捕获组 `(?:...)` |
| 选择分支 | `ab|cd`、`a|b|c`（允许空分支） |
| 锚点 | `^` 行首、`$` 行尾 |
| 转义 | `\.` `\+` `\\` `\t` `\n` `\r` `\f` `\v` 等 |

常见语法错误（括号未闭合、字符类未闭合、`{3,2}` 非法范围、区间颠倒、量词无对象、
未知转义等）都会在**出错位置**给出标记和中文原因。

匹配语义：在串中寻找**最左**匹配；贪婪取该起点的**最长**结果，懒惰取**最短**。

---

## 技术栈与模块划分

- **后端**：Node.js 20 + Express（ESM）。引擎全部独立成模块，互不依赖前端：

  ```
  server/src/
    parser/lexer.js         词法：字符类/预定义类/量词/转义，带位置的语法错误
    parser/ast.js           AST 节点工厂（每个节点带源码 [pos,end) 区间）
    parser/parser.js        递归下降语法分析
    charset.js              区间字符集：并/补/交、minterm 布尔划分、展示
    nfa/thompson.js         Thompson 构造 + 层次布局 + 构造步骤录制
    nfa/nfa-ops.js          ε-闭包（含 ^/$ 位置条件与接受依赖）
    dfa/subset.js           子集构造（minterm 字母表、死状态、截断、步骤录制）
    dfa/minimize.js         等价类划分细化最小化 + 合并步骤录制
    match/backtracker.js    回溯 DFS（贪婪最长/懒惰最短、捕获组、回溯帧、步数上限）
    match/nfa-sim.js        NFA 子集模拟（活跃状态集合，不回溯）
    match/dfa-sim.js        DFA 确定性模拟（唯一当前状态，不回溯）
    analysis/catastrophic.js 静态结构扫描 + 经验探针增长分级 + 改写建议
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
| `POST /api/compile` | `{pattern, dfaLimit, verifyStrings[]}` → AST + NFA + DFA + 最小 DFA + 一致性自检 |
| `POST /api/match` | `{pattern, input, engine, mode}`，engine ∈ `backtracking/nfa/dfa/minDFA`，mode ∈ `greedy/lazy`；返回逐帧 frames 与指标 |
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
