import { Controller, Body, Post, UnauthorizedError } from "routing-controllers";
import { compare } from "bcryptjs";
import { sign } from "jsonwebtoken";
import { sanitize} from "class-sanitizer";
import { AppOptions } from "../options/AppOptions";
import { Repository } from "../repository/Repository";
import { User } from "../models/User";
import { Role } from "../models/Role";
import { LoginViewModel } from "../viewModels/LoginViewModel";

@Controller("/auth")
export class AuthController {

    userRepository: any;
    roleRepository: any;

    constructor(private repository: Repository, private appOptions: AppOptions) {
        this.userRepository = this.repository.getRepository(User);
        this.roleRepository = this.repository.getRepository(Role);
    }

    @Post("/token")
    async createToken( @Body() viewModel: LoginViewModel) {
        sanitize(viewModel);
        const query = { email: viewModel.email };
        const user = await this.userRepository.findOne({
            where: query,
            join: {
                alias: "user",
                leftJoinAndSelect: {
                    roles: "user.roles",
                    claims: "roles.claims"
                }
            }
        });
        if (!user) {
            throw new UnauthorizedError("invalid email or password!");
        }
        const matched = await compare(viewModel.password, user.password);
        if (!matched) {
            throw new UnauthorizedError("invalid email or password!");
        }
        const roles = user.roles.map((role: Role) => role.name);
        const payload = {
            sub: user.id,
            role: roles,
            tenantId: user.tenantId,
            usage: "access_token",
            scope: new Array()
        };
        if (!roles.includes("admin")) {
            for (const role of user.roles) {
                const claims = role.claims.map((claim: any) => claim.claimValue);
                payload.scope.push(...claims);
            }
        }
        const token = sign(payload, this.appOptions.jwt.secret, { expiresIn: this.appOptions.jwt.expiry });
        user.lastLogin = new Date();
        await this.userRepository.save(user);
        return { access_token: token, expires_in: this.appOptions.jwt.expiry };
    }
}
