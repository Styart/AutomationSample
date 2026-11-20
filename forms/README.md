# Forms the agent can attach

`catalog.json` lists every file the agent may attach to a reply, and when. The build turns the ids into an enum in the reply schema, so the model cannot attach anything that is not listed here.

The PDF itself (`prequal-application-form.pdf`) is not in this repository: the original is a third party's form. Put your own file here before deploying; `scripts/deploy.mjs` stops if a listed file is missing.
