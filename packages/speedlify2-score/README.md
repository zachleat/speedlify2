# speedlify2-score

A zero-dependency web component that shows the Lighthouse scores a
[speedlify2](https://github.com/zachleat/speedlify2) instance has measured for a
URL, with the rest of the site's numbers in a tooltip on hover or focus.

```sh
npm install speedlify2-score
```

```js
import "speedlify2-score";
```

```html
<speedlify2-score speedlify-url="https://www.speedlify.dev/"></speedlify2-score>
```

With no `url` attribute it describes the page it is embedded on. Point it at
another measured URL to describe that one instead:

```html
<speedlify2-score
  speedlify-url="https://www.speedlify.dev/"
  url="https://www.11ty.dev/"></speedlify2-score>
```

No build step is required — the file is a standard ES module and can be loaded
straight from a `<script type="module">` if you would rather not install it.

## What it renders

Four Lighthouse scores as rings: Performance, Accessibility, Best Practices and
SEO. Everything else the instance knows — page weight, Core Web Vitals, axe
violations, when it was last measured — is in the tooltip.

## Attributes

| Attribute       | Required | Description                                                        |
| --------------- | -------- | ------------------------------------------------------------------ |
| `speedlify-url` | yes      | The root of the speedlify2 instance to read data from.              |
| `url`           | no       | The measured URL to describe. Defaults to the current page's URL.   |

## One request, no index

Unlike its predecessor, this component downloads no `urls.json` index. It works
out the data file for a URL by slugifying that URL in the browser with the same
rules the generator uses, so a page makes exactly one request for exactly the
data it shows. No index, no hashing, and no secure context needed.

The trade-off: a site whose slug collided with another is published under its
hash instead, and reads here as unmeasured rather than as the wrong site.

## Browser only

The element extends `HTMLElement`, which is resolved when the module is parsed,
so importing it on a server throws `HTMLElement is not defined`. In an app that
renders on the server, import it from a client-only entry point — `client:load`
in Astro, a `useEffect` or dynamic `import()` in React, `onMount` in Svelte.

## Exports

The element registers itself as `<speedlify2-score>` on import. The classes are
also exported if you want to subclass or register under a different tag name:

```js
import { SpeedlifyScore, SpeedlifyStore } from "speedlify2-score";

customElements.define("my-score", class extends SpeedlifyScore {});
```

## License

MIT
