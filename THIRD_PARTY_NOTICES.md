# Third-party notices

bedmcp's own code is under the MIT license ([LICENSE](LICENSE)). This file lists the code of other
projects that bedmcp ships or that the built client mod contains.

## Not included, installed by the user

bedmcp does not ship these. The user installs them (see the README), and bedmcp runs them as
separate programs:

| Project | License | How bedmcp uses it |
|---|---|---|
| [Be.D.D.](https://github.com/LiteLDev/BeDD) | LGPL-3.0 | runs `BeDD.exe` and talks to its WebSocket |
| [LeviLauncher](https://github.com/LiteLDev/LeviLauncher) | see its repository | the game instance Be.D.D. clones |
| Minecraft Bedrock and Bedrock Dedicated Server | Mojang / Microsoft terms | the game and server under test |

The test servers get LeviLamina and the BDS through `BeDD.exe server init` (lip), on the user's PC.

## Node.js packages (installed by npm, not in this repository)

- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk): MIT
- [zod](https://github.com/colinhacks/zod): MIT

## The client mod (mod/bin/BedmcpHot/BedmcpHot.dll)

The mod is built from `mod/src` (MIT). It loads **LeviLamina**'s DLL at run time, which the user's game
instance already has; LeviLamina is not included. The built DLL contains code from these headers:

### LeviLamina

- https://github.com/LiteLDev/LeviLamina, GNU Lesser General Public License v3.0
- The mod uses LeviLamina's headers (hooks, mod registration, and `ll/api/memory/MemoryOperators.h`,
  which routes `new`/`delete` through LeviLamina's allocator) and links dynamically to LeviLamina's DLL.
  Under LGPL-3.0 section 3, the mod may use such header material under terms of its own choice, with
  this notice. The full license text: https://www.gnu.org/licenses/lgpl-3.0.txt

### JSON for Modern C++ (nlohmann/json)

- https://github.com/nlohmann/json, MIT License

```
Copyright (c) 2013-2025 Niels Lohmann

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### EnTT (through LeviLamina's headers)

- https://github.com/skypjack/entt, MIT License

```
Copyright (c) 2017-2025 Michele Caini, author of EnTT

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Trademarks

Minecraft is a trademark of Mojang Synergies AB. bedmcp is not affiliated with Mojang or Microsoft.
