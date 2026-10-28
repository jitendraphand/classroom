# Teacher ranking

Ranks are a percentile of star ratings, **per academic year**. Written comments are not an input, and a rating counts only when that student was present (`admittedAt` is set).

## Score

A Bayesian average keeps a handful of ratings from jumping to the top or the bottom:

```
score = (C * prior + n * mean) / (C + n)
prior = 4.0
C     = 8
```

A teacher needs at least **5** present-student ratings before they receive a percentile. Below that, the snapshot still stores the average and the count, and the percentile is empty ("not enough ratings yet").

Among eligible teachers in that academic year:

```
percentile = 100 * (eligible teachers with a strictly lower score) / (N - 1)
```

One eligible teacher is the 100th percentile. Ties share a percentile (only strictly lower scores count).

## When it runs

The Next.js server (`src/instrumentation.ts`) checks once an hour. If the current week's snapshot is missing, it writes one. The week starts on Monday 00:00 in `APP_TIMEZONE` (default Asia/Kolkata). The previous week is filled in once if it was missed at the boundary.

An administrator with **View data and reports** can press **Update now** on Teacher performance. That rewrites the current week for the selected academic year.

Teachers see their own percentile and the week. They never receive the written feedback text. That text is available only on the admin Teacher performance tab, for one class at a time.
