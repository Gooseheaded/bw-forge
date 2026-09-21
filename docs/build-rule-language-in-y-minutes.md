# BW Build Rules in Y Minutes

Comments begin with `#`. Put one or more named rules in a file:

```text
# A compact Zerg example.
rule "2 Hatch Lurker (fast gas)" {
    # [2] means the second observed Hatchery event.
    hatchery[2] around 2:30

    # Supply references use the visible 0..200 scale.
    extractor[1] at 13 supply
    hatchery[2] around 12 supply

    # Relative ordering compares two observed events.
    metabolic_boost[1] before lair[1]
}
```

Event names are canonical lowercase keys, not display names:

```text
metabolic_boost[1]  # yes
Metabolic Boost[1]  # no
```

Units, buildings, upgrades, and tech all use the same form:

```text
marine[1]
command_center[2]
infantry_weapons[2] # second observed research start, not a level promise
siege_mode[1]
```

Use `m:ss` for time. Seconds always have two digits and must be below 60:

```text
spire[1] before 5:30
nexus[2] after 3:00
hatchery[2] around 2:30
```

Use an integer plus `supply` for supply predicates:

```text
refinery[1] before 13 supply
factory[1] after 20 supply
hatchery[2] around 12 supply
extractor[1] at 13 supply
```

`at N supply` is exact and crisp. The other time and supply forms—`around`, `before`, and `after`—are reference points awaiting future corpus calibration. They do not define a scoring curve yet.

Only `before` compares one event with another:

```text
siege_mode[1] before factory[2]
```

These three lines look similar, but their right-hand sides select different predicate types:

```text
spire[1] before 5:30       # time
spire[1] before 13 supply  # supply
spire[1] before lair[1]    # event order
```

Inline comments are fine, and whitespace is flexible:

```text
rule "Terran Example" {
    refinery[1] at 11 supply  # exact
    command_center[2] around 4:30
}
```

Check a file without running any replay queries:

```console
$ bw-forge rules test ./rules/zvt.bwbuild
bw-forge: rule file ./rules/zvt.bwbuild syntax is ok
bw-forge: rule file ./rules/zvt.bwbuild validation is successful
bw-forge: 1 rules validated
```

Common mistakes get source-located errors and, for close event-key typos, a suggestion. Rule names must be unique; occurrences start at 1; supply stays in `0..200`; and `2:60` is not a valid time.

That is the whole v0 language. There are no boolean expressions, weights, optional clauses, variables, includes, or replay evaluation yet.
