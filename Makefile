.PHONY: eval-full

eval-full:
	@echo "Full SWE-bench is operator-triggered and can cost roughly $$300 on a frontier model."
	@echo "Run a pinned SWE-bench/SWE-bench conversion first, then invoke tanya eval with the generated suite."
	@echo "For the bundled smoke benchmark, run: tanya eval --suite swe-bench-lite --out docs/benchmarks/swe-bench-lite-latest.json"
