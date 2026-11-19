- `build/register-vue` loads components on the test thread and keeps compiled
  components between test processes in a per-user cache directory, so Node
  tests that import views run about twice as fast. `GEV_VUE_CACHE=0` compiles
  every time (samehkhamis, #1500).
