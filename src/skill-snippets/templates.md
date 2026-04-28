## Template tool

`run-template <domain> <template-name> [--params <json>] [--params-file <path>]` runs a named template from a domain's `buildContext.templates` registry. Returns `{template, rows, columns, source, rowMeta?, narrative?}`.

The `--params` value is a single JSON-encoded string. Embedded quotes must be escaped — `args` is a flat array of strings (the shell argv), never a structured object.

Good example:
  {"tool":"run-template","args":["<domain>","<template>","--params","{\"key\":\"value\"}"]}
