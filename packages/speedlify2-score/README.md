# speedlify2-score

A zero-dependency web component that shows the Lighthouse scores a
[speedlify2](https://github.com/zachleat/speedlify2) instance has measured for a
URL, linking to that site's full report.

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

Six rings: the four Lighthouse scores — Performance, Accessibility, Best
Practices, SEO — then two more for axe (a full CLI run) and Core Web Vitals, the
two things those four do not cover. The rings link to the site's report on the
instance, where everything else it knows lives.

There is nothing to configure about the output, so a page carrying several
badges reads as one table rather than a row of different shapes.

## Attributes

| Attribute       | Required | Description                                                       |
| --------------- | -------- | ----------------------------------------------------------------- |
| `speedlify-url` | yes      | The root of the speedlify2 instance to read data from.             |
| `url`           | no       | The measured URL to describe. Defaults to the current page's URL.  |
| `theme`         | no       | `light` or `dark`. Absent, the badge follows the host page.        |

## Colors

The band colors are custom properties on the host, so a page can override any of
them: `--spdl-good`, `--spdl-average`, `--spdl-poor`, `--spdl-none` and
`--spdl-track`.

## One request, no index

Unlike its predecessor, this component downloads no `urls.json` index. It works
out the data file for a URL by slugifying that URL in the browser with the same
rules the generator uses, so a page makes exactly one request for exactly the
data it shows. No index, no hashing, and no secure context needed.

The trade-off: a site whose slug collided with another is published under its
hash instead, and reads here as unmeasured rather than as the wrong site.

## Exports

The element registers itself as `<speedlify2-score>` on import. The classes are
also exported if you want to subclass or register under a different tag name:

```js
import { SpeedlifyScore } from "speedlify2-score";

customElements.define("my-score", class extends SpeedlifyScore {});
```

## License

MIT
