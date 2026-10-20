# dsh-marginalia

Mark a span of the assistant reply in a DeepSeek Harness conversation. The actions appear at the upper-right of the caret, and a right-click opens the same card. Copy puts that span on the clipboard. Select that span again and the mark action becomes remove. A new question can choose a model; leaving it empty keeps the current conversation's model. A follow-up can choose another model for the next reply, and the opened child has the same choice above its input. Leaving that choice empty keeps the model already in use. A question underlines the span, leaves a citation mark, and opens that child in the side column. Follow up there the same way as the main conversation: the next turn extends downward on that page. A follow-up from the main conversation is delivered to the same child, and a follow-up inside the child continues it instead of nesting another one. The child keeps its own earlier answers and stays beside the main conversation. Its reply is not written under the main conversation. The citation note still shows the latest reply.

中文说明见 [README_ZH.md](./README_ZH.md).

Quit DeepSeek Harness completely and open it again before trying a new build. Notes are written under `~/.dsh/study-notes/`, not into the project repository.
