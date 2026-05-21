+++
title = "Hello World"
date = 2026-05-21
description = "First post on the new blog."
weight = 6
[taxonomies]
tags = ["meta"]

[extra]
toc = true
+++

This blog is built with **Zola** and the **Abridge** theme.

Writing a new post is as simple as creating a `.md` file in `content/blog/`:

```toml
+++
title = "My Post Title"
date = 2026-05-21
description = "Short description"
[taxonomies]
tags = ["tag1", "tag2"]
+++
```

Run `zola serve` to preview, `zola build` to generate the static site.
