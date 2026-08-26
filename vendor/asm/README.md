# ASM Core 9.9.1

The persistent JVM artifact worker uses the independently versioned ASM Core
bundle shipped in this source distribution at:

`vendor/jdtls/1.57.0/plugins/org.objectweb.asm_9.9.1.jar`

SHA-256:

`6f3828a215c920059a5efa2fb55c233d6c54ec5cadca99ce1b1bdd10077c7ddd`

ASM is distributed under the BSD 3-Clause license:
https://asm.ow2.io/LICENSE.txt

The build verifies the exact checksum before compiling the artifact worker.
This manifest deliberately separates the worker's dependency contract from
JDT.LS plugin discovery; a JDT.LS upgrade must not silently change ASM.
