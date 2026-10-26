#!/usr/bin/env python3
"""Zola 笔记格式检查。

扫一遍 Markdown，把「从对话/编辑器复制过来」的典型毛病找出来：

  - 缺 front matter
  - 零宽字符、私有区字符、`⸻` 这类看不见或不该出现的字符
  - Tab 分隔的伪表格（渲染成一行文本）
  - 没加围栏的代码块（换行会被压平）
  - 标题或正文里裸露的 `<T>`（会被当成 HTML 标签吞掉）
  - 无法渲染的 LaTeX
  - 重复的章节编号（多篇笔记拼接的痕迹）
  - 表格列数不一致、文件名不规范、weight 重复

用法:
    python3 scripts/check_notes.py                     # 检查 content/
    python3 scripts/check_notes.py content/log         # 检查目录
    python3 scripts/check_notes.py path/to/post.md     # 检查单文件
    python3 scripts/check_notes.py --quiet content/    # 只输出有问题的文件

退出码: 0 = 无错误（可能有警告），1 = 有错误，2 = 路径无效。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

INVISIBLE_CHARS = {
    "\u2060": "word joiner",
    "\u200b": "zero width space",
    "\u200c": "zero width non-joiner",
    "\u200d": "zero width joiner",
    "\ufeff": "byte order mark",
    "\u00a0": "no-break space",
}

# 会原样显示成怪字符的分隔线
FANCY_DASHES = {"\u2e3b": "THREE-EM DASH", "\u2015": "HORIZONTAL BAR"}

# Zola 未启用 math 时会被原样输出的 LaTeX 命令
LATEX_RE = re.compile(
    r"\\(?:boxed|frac|dfrac|sqrt|leq|geq|neq|iff|implies|text|operatorname|"
    r"forall|exists|cdot|times|min|max|sum|prod|left|right|quad|mathrm|mathbb|"
    r"begin|end)\b"
)

# 合法 HTML 标签，出现在尖括号里不算问题
HTML_TAGS = {
    "a", "abbr", "b", "blockquote", "br", "code", "dd", "del", "details", "div",
    "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
    "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "small", "span",
    "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th",
    "thead", "tr", "u", "ul", "video", "audio", "source", "figure",
    "figcaption", "input", "label", "button", "iframe", "script", "style",
    "link", "meta", "svg", "path", "use", "g", "circle", "rect", "line",
}

# 泛型/类型参数写法：<T>、<K, V>、<String>、<&'a str>
GENERIC_RE = re.compile(r"<([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_&'][A-Za-z0-9_' &]*)*)>")

# 形似代码的行首关键字
CODE_LINE_RE = re.compile(
    r"^(?:"
    r"fn\s+\w|pub\s+(?:fn|struct|enum|trait|type|const|static)\b|"
    r"impl\b|use\s+[\w:{}]|struct\s+\w|enum\s+\w|trait\s+\w|"
    r"let\s+(?:mut\s+)?\w|match\s+\w|mod\s+\w|"
    r"package\s+\w|func\s+\w|import\s+[\w(\"]|type\s+\w+\s+(?:struct|interface)|"
    r"var\s+\w|const\s+\w|"
    r"#\[|#!\[|"
    r"template\s*<|class\s+\w|namespace\s+\w|std::"
    r")"
)

SECTION_RE = re.compile(r"^(#{2,4})\s*([一二三四五六七八九十]+)、")
NUMBERED_RE = re.compile(r"^(#{2,4})\s*(\d+(?:\.\d+)*)\.?(?:\s|$)")
FILENAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*\.md$")

ERROR = "error"
WARN = "warn"


class Issue:
    __slots__ = ("level", "line", "msg")

    def __init__(self, level: str, line: int, msg: str):
        self.level = level
        self.line = line
        self.msg = msg


def split_front_matter(lines: list[str]) -> tuple[dict[str, str], int]:
    """返回 (front matter 字段, 正文起始行号)；没有 front matter 时返回 ({}, 0)。"""
    if not lines or lines[0].strip() not in ("+++", "---"):
        return {}, 0
    delim = lines[0].strip()
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == delim:
            end = i
            break
    if end is None:
        return {}, 0
    fields: dict[str, str] = {}
    for raw in lines[1:end]:
        m = re.match(r"^([A-Za-z_][\w]*)\s*=\s*(.+)$", raw.strip())
        if m:
            fields[m.group(1)] = m.group(2).strip()
    return fields, end + 1


def fence_mask(lines: list[str]) -> list[bool]:
    """标记每一行是否位于围栏代码块内（围栏行本身也算）。"""
    mask = [False] * len(lines)
    fence: str | None = None
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if fence is None:
            m = re.match(r"^(`{3,}|~{3,})", stripped)
            if m:
                fence = m.group(1)
                mask[i] = True
        else:
            mask[i] = True
            if re.match(r"^" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}\s*$", stripped):
                fence = None
    return mask


def strip_inline_code(line: str) -> str:
    """把行内代码替换成等长占位，方便后续正则不误伤。"""
    def repl(m: re.Match[str]) -> str:
        return " " * len(m.group(0))
    return re.sub(r"`[^`]*`", repl, line)


def check_front_matter(lines, fields, body_start, has_taxonomies: bool) -> list[Issue]:
    issues = []
    if not fields:
        issues.append(Issue(ERROR, 1, "缺少 front matter（文件必须以 +++ 或 --- 开头并闭合）"))
        return issues
    if "title" not in fields:
        issues.append(Issue(ERROR, 1, "front matter 缺少 title"))
    # 只有文章页才要求 date / weight；archive 之类的独立页面不强制
    if has_taxonomies:
        if "date" not in fields:
            issues.append(Issue(WARN, 1, "front matter 缺少 date"))
        if "weight" not in fields:
            issues.append(Issue(WARN, 1, "front matter 缺少 weight（同系列排序会不确定）"))
    return issues


def check_invisible(lines, mask) -> list[Issue]:
    issues = []
    for i, line in enumerate(lines):
        for ch, name in INVISIBLE_CHARS.items():
            if ch in line:
                issues.append(Issue(ERROR, i + 1, f"不可见字符 {name} U+{ord(ch):04X}"))
        for ch, name in FANCY_DASHES.items():
            if ch in line:
                issues.append(Issue(ERROR, i + 1, f"分隔线 {name}（应改成 ---）"))
        for ch in line:
            if 0xE000 <= ord(ch) <= 0xF8FF:
                issues.append(Issue(ERROR, i + 1, f"私有区字符 U+{ord(ch):04X}（界面残留，应删除）"))
                break
    return issues


def check_pseudo_table(lines, mask, body_start) -> list[Issue]:
    issues = []
    i = body_start
    while i < len(lines):
        if not mask[i] and "\t" in lines[i]:
            start = i
            while i < len(lines) and not mask[i] and "\t" in lines[i]:
                i += 1
            issues.append(
                Issue(ERROR, start + 1, f"Tab 分隔的伪表格（{i - start} 行），会渲染成一行文本")
            )
            continue
        i += 1
    return issues


def check_unfenced_code(lines, mask, body_start) -> list[Issue]:
    """顶格代码行 + 后续缩进/闭括号行、且未加围栏，视为漏加围栏的代码块。"""
    issues = []
    i = body_start
    while i < len(lines):
        if mask[i] or not lines[i].strip() or lines[i][0].isspace():
            i += 1
            continue
        if not CODE_LINE_RE.match(lines[i]):
            i += 1
            continue

        start = i
        j = i + 1
        while j < len(lines) and lines[j].strip() and not mask[j]:
            j += 1
        block = lines[start:j]

        has_brace = any(("{" in ln or "}" in ln) for ln in block)
        has_indent = any(ln[:1].isspace() for ln in block[1:])
        if len(block) >= 2 and (has_brace or has_indent):
            issues.append(
                Issue(ERROR, start + 1, f"疑似未加围栏的代码块（{len(block)} 行），换行会被压平")
            )
        i = j
    return issues


def check_angle_brackets(lines, mask, body_start) -> list[Issue]:
    issues = []
    for i in range(body_start, len(lines)):
        if mask[i]:
            continue
        line = lines[i]
        cleaned = strip_inline_code(line)
        for m in GENERIC_RE.finditer(cleaned):
            inner = m.group(1)
            head = inner.split(",")[0].strip().lstrip("&").split()[0]
            if head.lower() in HTML_TAGS:
                continue
            issues.append(
                Issue(ERROR, i + 1, f"裸露的尖括号 {m.group(0)}（会被当成 HTML 标签，用反引号包起来）")
            )
    return issues


def check_latex(lines, mask, body_start) -> list[Issue]:
    issues = []
    for i in range(body_start, len(lines)):
        if mask[i]:
            continue
        if LATEX_RE.search(strip_inline_code(lines[i])):
            issues.append(Issue(ERROR, i + 1, "无法渲染的 LaTeX（Zola 未启用 math，改成文本或代码块）"))
    return issues


def check_headings(lines, mask, body_start) -> list[Issue]:
    issues = []
    seen_cn: dict[str, int] = {}
    # 数字编号在不同父节下可以重用（如「如果是 Go」「如果是 Rust」都从 1. 起），
    # 所以按当前 h2 作用域分组
    seen_num: dict[tuple[str, str], int] = {}
    prev_level = 0
    stack: dict[int, str] = {}
    for i in range(body_start, len(lines)):
        if mask[i]:
            continue
        line = lines[i]
        m = re.match(r"^(#{1,6})\s+", line)
        if not m:
            continue
        level = len(m.group(1))
        if level == 1:
            issues.append(Issue(WARN, i + 1, "正文出现一级标题（会和页面标题重复），建议降为 ##"))
        if prev_level and level > prev_level + 1:
            issues.append(Issue(WARN, i + 1, f"标题层级跳级 h{prev_level} → h{level}"))
        prev_level = level

        # 维护按层级组织的标题栈，用于确定当前编号的父作用域
        stack[level] = line.strip()
        for k in [k for k in stack if k > level]:
            del stack[k]
        parent = max((k for k in stack if k < level), default=None)
        scope = stack[parent].lstrip("# ").strip() if parent else "（顶层）"

        cn = SECTION_RE.match(line)
        if cn:
            key = cn.group(2)
            seen_cn[key] = seen_cn.get(key, 0) + 1
        num = NUMBERED_RE.match(line)
        if num:
            key = (scope, num.group(2))
            seen_num[key] = seen_num.get(key, 0) + 1

    for key, count in sorted(seen_cn.items()):
        if count > 1:
            issues.append(Issue(ERROR, 0, f"章节编号「{key}、」重复出现 {count} 次（像是多篇笔记拼接）"))
    for (scope_name, key), count in sorted(seen_num.items()):
        if count > 1:
            issues.append(Issue(WARN, 0, f"「{scope_name}」下数字编号「{key}.」重复 {count} 次"))
    return issues


def check_tables(lines, mask, body_start) -> list[Issue]:
    issues = []
    i = body_start
    while i < len(lines):
        if mask[i] or not lines[i].lstrip().startswith("|"):
            i += 1
            continue
        start = i
        widths = []
        while i < len(lines) and not mask[i] and lines[i].lstrip().startswith("|"):
            widths.append(lines[i].count("|"))
            i += 1
        if len(set(widths)) > 1:
            issues.append(
                Issue(WARN, start + 1, f"表格列数不一致（{'/'.join(map(str, sorted(set(widths))))} 个竖线）")
            )
    return issues


def check_file_name(path: Path) -> list[Issue]:
    if path.name.startswith("_"):
        return []
    if not FILENAME_RE.match(path.name):
        return [Issue(WARN, 0, f"文件名不规范：{path.name}（建议小写 kebab-case，如 01-rust-topic.md）")]
    return []


def check_weights(paths: list[Path]) -> list[Issue]:
    """weight 只需在同一目录（同一系列）内唯一。"""
    by_dir: dict[Path, dict[int, list[str]]] = {}
    for p in paths:
        lines = p.read_text(encoding="utf-8").splitlines()
        fields, _ = split_front_matter(lines)
        raw = fields.get("weight")
        if raw and raw.isdigit():
            by_dir.setdefault(p.parent, {}).setdefault(int(raw), []).append(p.name)

    issues = []
    for directory, by_weight in sorted(by_dir.items()):
        for weight, names in sorted(by_weight.items()):
            if len(names) > 1:
                issues.append(
                    Issue(ERROR, 0, f"{directory.name}/ 内 weight = {weight} 重复：{', '.join(names)}")
                )
    return issues


def check_file(path: Path) -> list[Issue]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    fields, body_start = split_front_matter(lines)
    mask = fence_mask(lines)

    issues: list[Issue] = []
    has_taxonomies = any(ln.strip().startswith("[taxonomies]") for ln in lines)
    issues += check_front_matter(lines, fields, body_start, has_taxonomies)
    if not fields:
        # 没有 front matter 时按正文从 0 开始检查
        body_start = 0
    issues += check_invisible(lines, mask)
    issues += check_pseudo_table(lines, mask, body_start)
    issues += check_unfenced_code(lines, mask, body_start)
    issues += check_angle_brackets(lines, mask, body_start)
    issues += check_latex(lines, mask, body_start)
    issues += check_headings(lines, mask, body_start)
    issues += check_tables(lines, mask, body_start)
    issues += check_file_name(path)
    return issues


def collect(target: Path) -> list[Path]:
    if target.is_file():
        return [target]
    return sorted(p for p in target.rglob("*.md") if p.name != "_index.md")


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 Zola 笔记的常见格式问题")
    parser.add_argument("path", nargs="?", default="content", help="要检查的文件或目录")
    parser.add_argument("--quiet", action="store_true", help="只列出有问题的文件")
    parser.add_argument("--warn-only", action="store_true", help="把错误降级为警告（退出码始终为 0）")
    args = parser.parse_args()

    target = Path(args.path)
    if not target.exists():
        print(f"路径不存在: {target}", file=sys.stderr)
        return 2

    files = collect(target)
    if not files:
        print(f"{target} 下没有找到 .md 文件", file=sys.stderr)
        return 2

    total_errors = 0
    total_warns = 0
    dirty = 0

    for f in files:
        issues = check_file(f)
        errors = [i for i in issues if i.level == ERROR]
        warns = [i for i in issues if i.level == WARN]
        total_errors += len(errors)
        total_warns += len(warns)
        if not errors and not warns:
            if not args.quiet:
                print(f"  ok   {f}")
            continue
        dirty += 1
        print(f"\n{f}")
        for issue in sorted(issues, key=lambda x: (x.level != ERROR, x.line)):
            loc = f":{issue.line}" if issue.line else ""
            tag = "ERR " if issue.level == ERROR else "WARN"
            print(f"  {tag} {issue.msg}{loc}")

    if len(files) > 1:
        extra = []
        if target.is_dir():
            extra = check_weights(files)
        for issue in extra:
            total_errors += 1
            print(f"\n[目录级] ERR {issue.msg}")
        if extra:
            dirty += 1

    print(
        f"\n{'─' * 60}\n"
        f"检查 {len(files)} 个文件：{dirty} 个有问题，"
        f"{total_errors} 个错误，{total_warns} 个警告"
    )

    if args.warn_only:
        return 0
    return 1 if total_errors else 0


if __name__ == "__main__":
    sys.exit(main())
