"""Parser for MiniCPM5's native XML-style function calls.

MIT-compatible MLX-LM tool parser. See
https://github.com/ml-explore/mlx-lm/tree/main/mlx_lm/tool_parsers
"""

import ast
import json
import re


tool_call_start = "<function "
tool_call_end = "</function>"

_FUNCTION_RE = re.compile(r'^name=["\']([^"\']+)["\']>(.*)$', re.DOTALL)
_PARAM_RE = re.compile(
    r'<param\s+name=["\']([^"\']+)["\']>(.*?)</param>',
    re.DOTALL,
)


def _properties_for(function_name, tools):
    for tool in tools or []:
        function = tool.get("function") or tool
        if function.get("name") == function_name:
            return (function.get("parameters") or {}).get("properties") or {}
    return {}


def _convert(value, schema):
    value = value.strip()
    if value.startswith("<![CDATA[") and value.endswith("]]>"):
        value = value[9:-3]
    kind = (schema or {}).get("type")
    if kind == "boolean":
        return value.lower() == "true"
    if kind == "integer":
        return int(value)
    if kind == "number":
        number = float(value)
        return int(number) if number.is_integer() else number
    if kind in {"array", "object"}:
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return ast.literal_eval(value)
    if value.lower() == "null":
        return None
    return value


def parse_tool_call(text, tools=None):
    match = _FUNCTION_RE.match(text.strip())
    if not match:
        raise ValueError("Invalid MiniCPM5 function call")
    function_name, body = match.groups()
    properties = _properties_for(function_name, tools)
    arguments = {
        name: _convert(value, properties.get(name))
        for name, value in _PARAM_RE.findall(body)
    }
    return {"name": function_name, "arguments": arguments}
