#!/usr/bin/env zsh

# get the latest release's data

# first, find the data directory
mydir=${0:a:h}
updir=$(dirname -- "$mydir")
datadir="${updir}/src/data"

# next, determine the latest tag
tagname=$(gh release list -R moodswingsdata/moodswingsdatapipeline -L 1 --json tagName -q '.[].tagName')

# mention the tag and download the assets
printf "fetching assets for tag: $tagname\n"
$(cd "$datadir" ; gh release download "$tagname" --clobber -R moodswingsdata/moodswingsdatapipeline -p '*.json')
