"""Incrementally remove MiniCPM XML function calls from spoken text.

MIT-compatible adapter for LocalAI's MLX streaming backend. See
https://github.com/mudler/LocalAI/tree/v4.9.0/backend/python/mlx
"""


class FunctionStreamFilter:
    START = "<function"
    END = "</function>"

    def __init__(self):
        self._buffer = ""
        self._inside_function = False

    def push(self, chunk):
        self._buffer += chunk or ""
        visible = []

        while self._buffer:
            if self._inside_function:
                end = self._buffer.find(self.END)
                if end < 0:
                    return "".join(visible)
                self._buffer = self._buffer[end + len(self.END):]
                self._inside_function = False
                continue

            start = self._buffer.find(self.START)
            if start >= 0:
                visible.append(self._buffer[:start])
                self._buffer = self._buffer[start + len(self.START):]
                self._inside_function = True
                continue

            # Hold a short suffix so a marker split across token chunks cannot
            # leak to speech (for example "<fun" followed by "ction").
            safe_length = max(0, len(self._buffer) - len(self.START) + 1)
            if safe_length:
                visible.append(self._buffer[:safe_length])
                self._buffer = self._buffer[safe_length:]
            break

        return "".join(visible)

    def finish(self):
        if self._inside_function:
            self._buffer = ""
            return ""
        tail = self._buffer
        self._buffer = ""
        return tail
