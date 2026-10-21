# dsh-marginalia

在 DeepSeek Harness 的对话里，把值得留下的句子标出来，收成笔记，并就其中一句接着问。助手的回复和自己发出的内容都可以。问句开在旁边的侧栏里，主对话留在原来的页面。

[English](./README.md#english)

---

这是 DeepSeek Harness 桌面版的一个插件。对话页上，「学习」和「对话」并列。空白的新对话不显示这排标签。

你留在对话里，选中助手写给你的一段话，或自己发出的一段话。光标右上方会出现一张白卡片，右键打开的是同一张。卡片上有五件事：

| 按钮 | 做什么 |
|---|---|
| 复制 | 把选中的这段放进剪贴板。 |
| 标记 / 取消标记 | 给这段加上或去掉颜色。点标记后，上方浮出红、蓝、黄；加号打开调色板。自己选的颜色会留下，一共最多 5 种。颜色只留在原文上，不会自动进笔记。 |
| 划线 / 取消划线 | 给这段加金色下划线，或把下划线去掉。下划线只留在原文上，不会自动进笔记。 |
| 加入笔记 / 移出笔记 | 把选中的整段收进「学习」。原文出现浅灰色虚线下划线。再选中同一段，可以移出。 |
| 提问 / 追问 | 就这段发问。已经问过的，接着问同一条。 |

思考过程不会出现这张卡片。

## 笔记

「加入笔记」收进的整段，以及提问和追问，都进「学习」页。标记和划线不会自动出现在这里。每一条都能改摘录、问题和批注，也能删除。摘录会记下原文里的加粗、斜体和代码。上面是预览，落在这段里的标记颜色和金色划线也会画在预览上，下面一格是 Markdown，改完会保存。复制选区和「复制笔记」带上的也是这份 Markdown。同一大段里如果拆成了好几张，改摘录就能收成你想留的那一张，多余的删掉。

「笔记 · 数量」旁边可以按类别筛选，类别可以自己添加。每条笔记选一个类别，没选的是未分类。勾选之后可以全选当前筛出来的笔记，一起改类别或删除。复制笔记时带上类别，并且只复制当前筛出来的这些。

笔记写在本机的 `~/.dsh/study-notes/`（Windows 上是 `%USERPROFILE%\.dsh\study-notes\`），按工作区分开，里面是 `index.json` 和对应的 Markdown。不写进你正在打开的项目仓库。

再选中同一段，按钮变成「取消标记」「取消划线」或「移出笔记」。取消标记和取消划线只去掉原文上的颜色或金色下划线。移出笔记会从「学习」里拿走整段，并去掉虚线下划线。选区跟已有标注重叠，或去掉空白后是同一句，也算这一条。别处还有一句完全相同的文字时，会一起取消。

## 就一句话提问

选「提问」，写上例如「这段是什么」，也可以先选模型。

这句话不会被划线。问题和摘录记在「学习」里。这句话还在对话里时，句末出现一个小引用符号：

- 合上时，只有这个符号。
- 点开后，是贴在这句话旁边的便利贴，里面是你的问题和这条进程最新的一条回复。
- 回复还没写完时，便利贴上是「正在回答…」。
- 按 Esc，或点「合上」，便利贴收起。

提问不会把主对话换成另一页。回答写在侧栏里，不写到主对话下面。旁边的「任务管理」仍能看见这条进程。

## 一条进程可以一直问下去

一条笔记对应一条进程。不同的句子是并排的几条，互不套娃。

这条进程开在右侧栏，输入方式和主对话一样，新的一轮往下接在同一页。下面三种问法都进这一条，不会再套出「主进程 → 子进程 → 子进程」：

- 在侧栏里直接打字。
- 在主对话里对同一句再点「追问」。
- 在已经打开的这条进程里再选一段追问。

它记得自己前面的回答。更早那种问完即止、不能接着写的进程，需要回到主对话重新提问。

## 模型

三处可以选模型：选中文字后浮出的提问卡、「学习」页上的提问或追问、以及已经打开的子进程输入框上方。

- 「跟随当前对话」：新开的这条用你当前对话的模型。
- 「沿用当前模型」：这次追问不换。
- 点名一个模型：新进程从这一轮就用它；已经打开的进程，从下一条回复起用它。正在写的那一条不会中途换掉。

列表里先是 DeepSeek V4 Pro 和 DeepSeek Flash，然后是桌面配置 `profiles/desktop/cordis.patch.yml` 里写明的模型。没有的模型会提示「没有这个模型」。子进程页面上，软件自带的模型菜单不会出现，所以换模型用的是输入框上方这一处。

## 安装

从 npm 安装当前发布的版本。profile 名一般是 `desktop`。

```bash
dsh plugin --profile desktop add dsh-marginalia
```

要固定版本，把包名写成 `dsh-marginalia@0.1.3`。装好或更新后，把 DeepSeek Harness 完全退出，包括托盘图标，再打开。只关窗口不够。

也可以从本机目录安装。把路径换成这套插件所在的目录：

```bash
dsh plugin --profile desktop add ./path/to/dsh-marginalia
```

查看 npm 上的版本：

```bash
npm view dsh-marginalia version
```

包页面是 https://www.npmjs.com/package/dsh-marginalia 。

要求 Node.js 20 或更高，DeepSeek Harness `>=0.2.1-rc.2 <0.3`。这份 0.1.3 是按桌面版 `0.2.1-rc.2` 写的。

不要把本插件再写进 profile 自己的 `cordis.patch.yml`。命令行看到 `package.json` 里的 `dsh.bundle.patch` 后，会自己把 `cordis.patch.yml` 接上。写两遍会挂两次。

## 边界

- 一次标注最多 4000 字。一条对话最多 400 条。一条批注、一个问题最多 2000 字。
- 便利贴里的回复最多显示 20000 字。
- 还没有自动整理，也没有导出 PDF。
- 进程没在运行时，换模型会提示「这条进程没有在运行，换不了模型。」

本地检查：

```bash
node --test lib/model.test.js lib/quote.test.js
```

## 发布到 npm

同一版本只能发布一次。先改版本号，再发布。`--no-git-tag-version` 只改 `package.json`，不会自己做 Git 提交，因此不需要先设置 Git 作者。

```bash
npm login
npm whoami
npm version patch --no-git-tag-version
npm publish --access public
```

`npm login` 在 npm 11 里会打开网页确认。成功时 `npm whoami` 显示用户名，`npm publish` 的最后一行是 `+ dsh-marginalia@x.y.z`。

如果发布返回 403，并写着需要 two-factor authentication 或 granular access token with bypass 2fa，网页登录留下的令牌不能用来发版。到 https://www.npmjs.com/settings/~/tokens 新建 Granular Access Token，权限选 Read and write，范围选 All packages，并勾选 Bypass two-factor authentication。然后在自己的终端执行 `npm config set //registry.npmjs.org/:_authToken`，后面接那枚新令牌，再重新 `npm publish --access public`。不要把令牌或验证码写进仓库、对话或截图。发完可以删掉这枚令牌。

## 许可

MIT。Copyright (c) 2026 Angry.fish。见 [LICENSE](./LICENSE)。
