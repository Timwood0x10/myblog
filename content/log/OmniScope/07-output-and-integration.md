+++
title = "Reporting Pipeline: Issue Objects, JSON, SARIF, and Engineering Integration"
date = 2026-05-21
description = "Static analysis results need to be reviewable and machine-readable. OmniScope’s reporting path starts with `Issue` objects, then emits text, JSON, or SARIF through `emitOutput`."
weight = 22
[taxonomies]
tags = ["Rust", "LLVM", "FFI"]
series = ["OmniScope"]
[extra]
series = "OmniScope"
+++

# Reporting Pipeline: Issue Objects, JSON, SARIF, and Engineering Integration

Static analysis results need to be reviewable and machine-readable. OmniScope’s reporting path starts with `Issue` objects, then emits text, JSON, or SARIF through `emitOutput`.

## Start with the problem: plain-text alerts do not integrate well

Cross-language audit results are not only read by a human once. CI needs artifacts and status decisions, security platforms consume SARIF, secondary tooling reads JSON, and developers need reason, confidence, and FFI context. If each pass prints text directly, that information is hard to consume reliably.

## OmniScope’s entry point: Issue as the shared middle layer

OmniScope makes passes produce structured `Issue` values first, then lets the output layer serialize them as text, JSON, or SARIF. Analysis logic, evidence fields, and engineering integration stay separate: passes find problems, `Issue` stores evidence, and `emitOutput` decides how to deliver it.

## Issue is the shared result type

`Issue` is defined in `src/diag/issue.zig`, and issue kinds are exposed from `src/common/types.zig:151`. The structure carries kind, message, location, severity, confidence, confidence level, reason, FFI boundary, trace, and classification.

{% mermaid() %}
classDiagram
    class Issue {
        kind
        message
        location
        severity
        confidence
        confidence_level
        reason
        ffi_boundary
        trace
        classification
    }
{% end %}

These fields support different review needs:

- `severity` helps triage.
- `confidence` and `confidence_level` distinguish stronger evidence from heuristics.
- `reason` records the rule rationale.
- `ffi_boundary` marks cross-language context.
- `trace` leaves room for evidence paths.
- `classification` separates FFI-boundary findings from local-only findings.

## From Pass to Issue

When a pass finds something reportable, it creates an `Issue` with constructors such as `Issue.init` or `Issue.initWithReason`, then calls `ctx.addIssue`. The entry point is `src/pass/pass.zig:458`.

{% mermaid() %}
flowchart TD
    A[Analysis Pass] --> B[Rule match]
    B --> C[Construct Issue]
    C --> D[ctx.addIssue]
    D --> E[DataFlowGraph / Issue store]
    E --> F[Pipeline.getIssues]
    F --> G[emitOutput]
{% end %}

This decouples rule logic from output format. Passes produce structured findings; the main program decides how to serialize them.

## `emitOutput` dispatches formats

`emitOutput` is implemented at `src/main.zig:207`. The JSON branch calls `formatIssuesAsJson` at `src/main.zig:494`; the SARIF branch uses `SarifOutput`, initialized at `src/main.zig:232`; file output is controlled by `config.output_file`.

{% mermaid() %}
flowchart LR
    A[issues + func_count + time_ms] --> B[emitOutput]
    B --> C{OutputFormat}
    C -->|json| D[formatIssuesAsJson]
    C -->|sarif| E[SarifOutput.generate]
    C -->|text| F[terminal diagnostics]
    D --> G[stdout or file]
    E --> G
    F --> H[developer console]
{% end %}

## SARIF integration

`SarifOutput` is defined at `src/output/sarif.zig:36`, with file writing at `src/output/sarif.zig:167`. SARIF lets results be consumed by GitHub Code Scanning, CI systems, and security dashboards.

{% mermaid() %}
flowchart TD
    A[OmniScope Issue] --> B[SARIF Result]
    B --> C[sarif.json]
    C --> D[CI Artifact]
    C --> E[GitHub Code Scanning]
    C --> F[Security Dashboard]
{% end %}

## Example commands

Local inspection:

```bash
omniscope input.ll
```

Structured JSON:

```bash
omniscope --json -o omniscope-report.json input.ll
```

SARIF for CI or code scanning:

```bash
omniscope --sarif -o omniscope.sarif input.ll
```

FFI-focused mode:

```bash
omniscope --ffi-only input.ll
```

## Confidence and review boundaries

Confidence is not decorative. Cross-language static analysis can be affected by optimization, missing symbols, debug information quality, wrappers, and custom allocators. Exposing confidence, reason, and trace fields helps reviewers inspect the analyzer’s reasoning instead of relying only on alert color.

## Summary

The reporting path separates analysis from serialization: passes produce structured issues, `emitOutput` selects the output format, and JSON/SARIF make the results usable in engineering workflows.

## Source breakdown: `emitOutput` is format dispatch, not analysis logic

`emitOutput` in `src/main.zig:207` only dispatches by `config.output_format`. It does not reinterpret risk.

```zig
fn emitOutput(allocator: std.mem.Allocator, issues: []const Issue, func_count: usize, time_ms: u64, config: Config) !void {
    if (issues.len == 0 and config.output_format == .text) return;

    if (config.output_format == .json) {
        const json_output = formatIssuesAsJson(allocator, issues, func_count, time_ms) catch |err| {
            log.err("Failed to format JSON output: {}\n", .{err});
            return;
        };
    } else if (config.output_format == .sarif) {
        var sarif = SarifOutput.init(allocator, "OmniScope", "0.1.8");
        const sarif_output = sarif.generate(issues) catch |err| {
            log.err("Failed to generate SARIF output: {}\n", .{err});
            return;
        };
    } else {
        if (issues.len > 0) {
            log.info("Issues detected: {d}\n", .{issues.len});
        }
    }
}
```

That boundary is important. Analysis passes should not know whether a finding will be consumed by GitHub Code Scanning, a CI artifact, or a terminal. The output layer should not reinterpret severity or confidence either, otherwise JSON and SARIF could drift semantically.

## Source breakdown: JSON exposes evidence strength

`formatIssuesAsJson` in `src/main.zig:494` writes more than kind, message, and location. It includes summary, confidence, confidence score, CWE, and reason.

```zig
try writer.writeAll("{\"schema_version\":\"1.0.0\",\"tool\":\"omniscope\",\"tool_version\":\"0.1.8\",\"timestamp\":");
try writer.writeAll(",\"summary\":{");
try writer.print("\"functions\":{d},\"issues\":{d},\"time_ms\":{d}", .{ func_count, issues.len, analysis_time_ms });

try writer.writeAll("{\"id\":\"");
try writer.print("OMI-{d:0>3}", .{idx + 1});
try writer.writeAll("\",\"kind\":\"");
try writer.writeAll(@tagName(issue.kind));
try writer.writeAll("\",\"severity\":\"");
try writer.writeAll(@tagName(issue.severity));
try writer.writeAll("\",\"confidence\":\"");
try writer.writeAll(issue.confidence_level.toString());
try writer.writeAll("\",\"confidence_score\":");
try writer.print("{d:.2}", .{issue.confidence});
try writer.writeAll(",\"cwe_id\":");
try writer.print("{d}", .{cwe_id});
```

The reporting design is built around auditability. `confidence_score` exposes evidence strength, `reason` explains the rule, `cwe_id` connects to security programs, and `summary.time_ms` gives CI a performance signal.

## `Issue` is the external contract

`Issue` in `src/diag/issue.zig` standardizes findings as kind, message, location, severity, confidence, confidence level, reason, FFI boundary, trace, and classification.

Those fields form OmniScope’s external contract:

- `kind` and `severity` describe type and priority.
- `confidence` and `confidence_level` describe evidence strength.
- `reason` explains why the rule fired.
- `ffi_boundary` and `classification` distinguish local-only issues from boundary-relevant issues.
- `trace` leaves room for evidence paths and visualization.

Keeping these fields in `Issue`, rather than scattering them across JSON/SARIF formatters, makes the report schema part of the analysis model rather than a string-rendering detail.

## Engineering integration needs stable schema, not pretty output

Terminal output is useful for demos, but engineering systems need stable structure. CI needs artifacts, security platforms need SARIF, secondary tooling needs JSON, and developers need reason and trace. OmniScope’s `Issue -> JSON/SARIF/Text` path keeps those consumers on the same semantics.

The important part is bigger than "supports JSON and SARIF":  OmniScope models cross-language findings as structured issues with confidence, CWE, location, FFI classification, and explanatory evidence, then serializes that contract into machine-consumable formats.
