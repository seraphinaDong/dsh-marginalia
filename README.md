# dsh-marginalia

在 DeepSeek Harness 的对话里，把助手回复中值得留下的句子标出来，收成笔记，并就其中一句接着问。问句开在旁边的侧栏里，主对话留在原来的页面。

Mark a sentence in an assistant reply inside DeepSeek Harness, keep it as a note, and ask about that sentence alone. The question opens in the side column. The main conversation stays where it is.

[中文说明](#中文) · [English](#english)

---

## 中文

这是 DeepSeek Harness 桌面版的一个插件。对话页上，「学习」和「对话」并列。空白的新对话不显示这排标签。

你留在对话里，选中助手写给你的一段话。光标右上方会出现一张白卡片，右键打开的是同一张。卡片上有四件事：

| 按钮 | 做什么 |
|---|---|
| 复制 | 把选中的这段放进剪贴板。 |
| 标红 / 取消标红 | 给这段加上或去掉红色标出。 |
| 划线 / 取消划线 | 给这段加下划线，或把下划线去掉。 |
| 提问 / 追问 | 就这段发问。已经问过的，接着问同一条。 |

自己发出的消息，以及思考过程，不会出现这张卡片。

### 笔记

标过的句子进「学习」页。每一条都能写批注、删除。页顶的「复制笔记」把当前这份列表复制成 Markdown。

笔记写在本机的 `~/.dsh/study-notes/`（Windows 上是 `%USERPROFILE%\.dsh\study-notes\`），按工作区分开，里面是 `index.json` 和对应的 Markdown。不写进你正在打开的项目仓库。

同一段再选一次，按钮变成「取消标红」或「取消划线」，整条标注会从对话和笔记里拿掉。选区跟已有标注重叠，或去掉空白后是同一句，也算这一条。别处还有一句完全相同的文字时，会一起取消。

### 就一句话提问

选「提问」，写上例如「这段是什么」，也可以先选模型。

这句话会被划线。句末出现一个小引用符号：

- 合上时，只有这个符号。
- 点开后，是贴在这句话旁边的便利贴，里面是你的问题和这条进程最新的一条回复。
- 回复还没写完时，便利贴上是「正在回答…」。
- 按 Esc，或点「合上」，便利贴收起。

提问不会把主对话换成另一页。回答写在侧栏里，不写到主对话下面。旁边的「任务管理」仍能看见这条进程。

### 一条进程可以一直问下去

一条划线对应一条进程。不同的句子是并排的几条，互不套娃。

这条进程开在右侧栏，输入方式和主对话一样，新的一轮往下接在同一页。下面三种问法都进这一条，不会再套出「主进程 → 子进程 → 子进程」：

- 在侧栏里直接打字。
- 在主对话里对同一句再点「追问」。
- 在已经打开的这条进程里再划线追问。

它记得自己前面的回答。更早那种问完即止、不能接着写的进程，需要回到主对话重新提问。

### 模型

三处可以选模型：划线后浮出的提问卡、「学习」页上的提问或追问、以及已经打开的子进程输入框上方。

- 「跟随当前对话」：新开的这条用你当前对话的模型。
- 「沿用当前模型」：这次追问不换。
- 点名一个模型：新进程从这一轮就用它；已经打开的进程，从下一条回复起用它。正在写的那一条不会中途换掉。

列表里先是 DeepSeek V4 Pro 和 DeepSeek Flash，然后是桌面配置 `profiles/desktop/cordis.patch.yml` 里写明的模型。没有的模型会提示「没有这个模型」。子进程页面上，软件自带的模型菜单不会出现，所以换模型用的是输入框上方这一处。

### 安装

把路径换成这套插件所在的目录。profile 名一般是 `desktop`。

```bash
dsh plugin --profile desktop add ./path/to/dsh-marginalia
```

装好或更新后，把 DeepSeek Harness 完全退出，包括托盘图标，再打开。只关窗口不够。

要求 Node.js 20 或更高，DeepSeek Harness `>=0.2.0-rc <0.3`。这份 0.1.0 是按桌面版 `0.2.0-rc.2` 写的。

不要把本插件再写进 profile 自己的 `cordis.patch.yml`。命令行看到 `package.json` 里的 `dsh.bundle.patch` 后，会自己把 `cordis.patch.yml` 接上。写两遍会挂两次。

### 边界

- 一次标注最多 4000 字。一条对话最多 400 条。一条批注、一个问题最多 2000 字。
- 便利贴里的回复最多显示 20000 字。
- 还没有自动整理，也没有导出 PDF。
- 进程没在运行时，换模型会提示「这条进程没有在运行，换不了模型。」

本地检查：

```bash
node --test lib/model.test.js lib/quote.test.js
```

## English

dsh-marginalia is a desktop plugin for DeepSeek Harness. On the conversation page, a tab named 学习 sits beside 对话. A blank new chat hides that tab row.

Stay in the conversation and select part of the assistant's reply. A white card appears at the upper right of the caret. A right-click opens the same card.

| Button | What it does |
|---|---|
| 复制 | Copy the selection. |
| 标红 / 取消标红 | Mark the span red, or clear that mark. |
| 划线 / 取消划线 | Underline the span, or clear the underline. |
| 提问 / 追问 | Ask about this span. If you already asked, continue that same side conversation. |

Your own messages and the reasoning trace do not open this card.

### Notes

Marked sentences are listed on the 学习 page. Each row can take a comment, and each row can be deleted. 复制笔记 copies the current list as Markdown.

Notes are stored on this machine under `~/.dsh/study-notes/` (`%USERPROFILE%\.dsh\study-notes\` on Windows), grouped by workspace, as `index.json` plus a Markdown file. They are not written into the project you have open.

Select the same span again and the button becomes 取消标红 or 取消划线. That removes the whole mark from the conversation and from the notes. An overlapping selection, or the same words with different line breaks, counts as that mark. The same quote elsewhere is removed with it.

### Ask about one sentence

Choose 提问 and type something like “这段是什么”. You can pick a model first.

The sentence is underlined, and a small citation mark sits at the end:

- Collapsed, only that mark is visible.
- Expanded, a sticky note beside the sentence shows your question and the latest reply.
- Until the reply is finished, the note says 正在回答….
- Esc, or 合上, closes it.

The question does not replace the main conversation. The reply is written in the side column, not under the main conversation. The side task list still shows this child.

### One child keeps going

One underline is one side conversation. Different sentences are parallel conversations. They do not nest inside each other.

The child opens in the right column. You type there the same way as in the main conversation, and the next turn extends downward on that page. These three actions all continue that same child:

- Type in the side column.
- Choose 追问 on the same sentence in the main conversation.
- Select text inside the open child and ask again.

The child keeps its own earlier answers. An older one-shot child cannot be continued. Ask again from the main conversation.

### Models

You can choose a model in three places: the card that appears after a selection, the ask form on the 学习 page, and the control labeled 模型 above the input of an open child.

- 跟随当前对话 starts the new child with the model of the conversation you asked from.
- 沿用当前模型 leaves the current model in place for this follow-up.
- A named model is used from the first turn of a new child, or from the next reply of a child that is already open. A reply that is already being written is left as it is.

The list starts with DeepSeek V4 Pro and DeepSeek Flash, then the models declared in `profiles/desktop/cordis.patch.yml`. An unknown model is refused with 没有这个模型. The app's own model menu is absent on a child page, so the switch for that page is the 模型 control above its input.

### Install

Replace the path with the directory that contains this plugin. The profile name is usually `desktop`.

```bash
dsh plugin --profile desktop add ./path/to/dsh-marginalia
```

After installing or updating, quit DeepSeek Harness completely, including the tray icon, then open it again. Closing the window is not enough.

Requires Node.js 20 or newer, and DeepSeek Harness `>=0.2.0-rc <0.3`. Version 0.1.0 was written against desktop `0.2.0-rc.2`.

Do not also insert this plugin into the profile's own `cordis.patch.yml`. The CLI reads `dsh.bundle.patch` in `package.json` and appends `cordis.patch.yml` itself. Adding it twice mounts the plugin twice.

### Limits

- One mark is at most 4000 characters. One conversation holds at most 400 marks. A comment or a question is at most 2000 characters.
- The sticky note shows at most 20000 characters of the reply.
- There is no automatic summary and no PDF export.
- If the child is not running, changing its model reports 这条进程没有在运行，换不了模型。

Check the package locally:

```bash
node --test lib/model.test.js lib/quote.test.js
```

## License

MIT. Copyright (c) 2026 Angry.fish. See [LICENSE](./LICENSE).
