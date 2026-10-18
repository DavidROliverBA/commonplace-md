# Books

```dataview
TABLE author AS "Author", status AS "Status", rating AS "Rating"
FROM "Reading"
WHERE type = "Book"
SORT rating DESC
```
