# terminal-zen blog — Makefile

build:
	zola build

clean:
	rm -rf public

serve:
	zola serve

.PHONY: build clean serve