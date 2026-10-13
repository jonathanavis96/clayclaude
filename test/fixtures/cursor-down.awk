# Used by the pane stubs (prompt-screen.sh, race-screen.sh): a screen as Claude redraws it after Down in one of its
# unnumbered startup dialogs. The first line whose first non-space character is "❯" loses it, and the line under it
# gains it at the same column. Run with LC_ALL=C (byte-wise; the cursor's column is all spaces before it).
{ line[NR] = $0 }
END {
  k = 0
  for (i = 1; i <= NR; i++) if (line[i] ~ /^ *❯ /) { k = i; break }
  if (k > 0 && k < NR && line[k + 1] ~ /^ *[^ ]/) {
    p = index(line[k], "❯") - 1
    if (substr(line[k + 1], p + 1, 1) == " ") {
      sub(/❯/, " ", line[k])
      line[k + 1] = substr(line[k + 1], 1, p) "❯" substr(line[k + 1], p + 2)
    }
  }
  for (i = 1; i <= NR; i++) print line[i]
}
