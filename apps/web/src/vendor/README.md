# Pinned DeepSeek Harness visual assets

Copied without modification from the accepted `docs/prototype/vendor` assets, grounded in DeepSeek Harness **0.2.1-alpha.1**, commit **5badb15009ae1756c3afe0ae0cef1faafc290ccc**.

Source: https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-theme/src/styles

- `base.css`: system and code font stacks, radii and motion variables
- `design-platform.css`: complete semantic light/dark tokens; dark theme is selected by `body[data-ds-dark-theme]`
- `gradient-shadow-text.css`: theme-aware elevation and text effects
- `corner-shape.css`: progressive superellipse enhancement; circles opt out in the component stylesheet
- `brand-font.css` and the three Montserrat WOFF2 files: local-only brand typeface at weights 300, 400, 500

The application stylesheet only consumes these tokens. Keep the original MIT notice in `DSH-LICENSE` and font license in `Montserrat-OFL.txt` with copied assets. No external font service or dependency is used. This is a source-grounded adaptation, not an official DeepSeek product or an assertion of pixel identity.
