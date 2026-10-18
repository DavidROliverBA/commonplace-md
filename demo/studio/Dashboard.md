# Dashboard

## Projects

```dataview
TABLE status AS "Status", due AS "Due", people AS "People"
FROM "Projects"
SORT due ASC
```

## Open actions from meetings

```dataview
TASK
FROM "Meetings"
WHERE !completed
```

## Everyone

```dataview
LIST role
FROM "People"
SORT file.name ASC
```
