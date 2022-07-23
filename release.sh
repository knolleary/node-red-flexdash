#! /bin/bash -ex

# read commandline options
RELEASE=0
while getopts ":h" opt; do
  case $opt in
    h)
      echo "Usage: $0 [-h] [-r]"
      echo " -h show this help message and exit"
      echo " -r release the version"
      exit 0
      ;;
    r)
      RELEASE=1
      ;;
    \?)
      echo "Invalid option: -$OPTARG" >&2
      exit 1
      ;;
  esac
done

v=$(npm version --no-git-tag-version patch)
(cd plugin; npm version --no-git-tag-version $v)
vmm=${v%.*}
vmm=${vmm#v}
./bundle.sh $vmm
git commit -a -m "version $v"
git push
( cd plugin;
  npm publish --tag dev;
  if [[ $RELEASE == 1 ]]; then npm publish --tag latest; fi
)
npm publish
if [[ $RELEASE == 1 ]]; then npm publish --tag latest; fi
