# Time Clock

A simple clock-in/clock-out app for iPhone that makes a monthly invoice as a Word file and a PDF.

- `app/` is the whole app (this folder gets published to GitHub Pages).
- `app/template/invoice-template.docx` is the starter invoice template.
- `tools/make_template.py` rebuilds the starter template; `tools/make_icons.py` rebuilds the icons.

## Template placeholders

Type these anywhere in the Word file and the app fills them in:

| Placeholder | Becomes |
|---|---|
| `{my_name}` `{my_email}` `{bill_to}` `{notes}` | From the app's Settings tab |
| `{invoice_number}` `{period}` | e.g. `7`, `October 2026` |
| `{invoice_date}` | The day you make the invoice, e.g. `October 31, 2026` |
| `{total_hours}` `{rate}` `{subtotal}` | e.g. `70.00`, `25.00`, `1,750.00` (hours × rate) |
| `{wire_fee}` `{total}` | e.g. `15.00`, `1,765.00` (subtotal + wire fee) |

The hours table needs one row with `{#shifts}{date}` in the first cell, `{in}` and `{out}` in the middle cells,
and `{hours}{/shifts}` in the last cell. That row repeats once per shift. Dates look like `10/20`.

## Test locally

    cd app
    python -m http.server 8765
