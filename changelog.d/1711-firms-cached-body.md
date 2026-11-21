- `/api/firms` keeps its response bytes and sends them gzipped instead of
  serialising the whole fire set for every request (mazy1998, #1711).
