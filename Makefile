THEME_DIR = themes/terminimal
THEME_REPO = https://github.com/pawroman/zola-theme-terminimal.git

build: $(THEME_DIR)/.git
	zola build

$(THEME_DIR)/.git:
	rm -rf $(THEME_DIR)
	git clone --depth 1 $(THEME_REPO) $(THEME_DIR)

clean:
	rm -rf public $(THEME_DIR)

.PHONY: build clean
