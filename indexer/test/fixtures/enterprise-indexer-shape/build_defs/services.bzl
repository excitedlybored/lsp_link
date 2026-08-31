def example_deploy(name):
    native.filegroup(
        name = name,
        srcs = ["//:repository_shape"],
        tags = ["deployment"],
    )
